//! AppEvent projection into the foreground app state.

use super::*;

pub(super) async fn handle_app_event(
    event: AppEvent,
    app: &mut ReplApp,
    engine: &QueryEngine,
    tx: &AppEventSender,
    _prompt: &TuiPermissionPrompt,
) -> HandledAppEvent {
    match event {
        AppEvent::Terminal(CEvent::Key(key)) => {
            let action = app.handle_key(key);
            if let Some(action) = action {
                HandledAppEvent::action(action)
            } else {
                HandledAppEvent::redraw()
            }
        }
        AppEvent::Terminal(CEvent::Resize(width, height)) => {
            app.observe_terminal_resize(Size::new(width, height));
            HandledAppEvent::redraw()
        }
        AppEvent::Terminal(CEvent::Mouse(mouse)) => {
            let was_dragging_scrollbar = app.transcript_viewport.drag_active();
            if let Some(action) = handle_mouse_event(mouse, app) {
                HandledAppEvent::action(action)
            } else if matches!(mouse.kind, MouseEventKind::Moved) && !was_dragging_scrollbar {
                HandledAppEvent::quiet()
            } else {
                HandledAppEvent::redraw()
            }
        }
        AppEvent::Terminal(CEvent::Paste(text)) => {
            if !app.handle_paste_text_for_active_overlay(&text) {
                match app.handle_paste_text(&text) {
                    Ok(()) => {}
                    Err(error) => {
                        app.push_message(MessageRole::System, format!("[paste input] {error}"))
                    }
                }
            }
            HandledAppEvent::redraw()
        }
        AppEvent::Terminal(CEvent::FocusGained) => {
            // The cached fg/bg colors come from the startup probe (run before
            // the crossterm event reader was spawned, see run_repl_with_engine).
            // We deliberately do NOT call `terminal_palette::requery_default_colors`
            // here: that path writes OSC 10/11 queries to the tty and crossterm
            // 0.28's input parser does not understand OSC sequences, so the
            // responses would race the parser and leak into the prompt buffer
            // the same way the startup probe did before the fix.
            HandledAppEvent::redraw()
        }
        AppEvent::Terminal(CEvent::FocusLost) => HandledAppEvent::quiet(),
        AppEvent::ClipboardImageReady(image) => {
            app.clipboard_image_paste_in_flight = false;
            match app.attach_clipboard_image(image) {
                Ok(()) => app.set_transient_status("Attached image from clipboard"),
                Err(error) => {
                    app.push_message(MessageRole::System, format!("[clipboard image] {error:#}"))
                }
            }
            HandledAppEvent::redraw()
        }
        AppEvent::ClipboardImageFailed(error) => {
            app.clipboard_image_paste_in_flight = false;
            app.set_transient_status(format!(
                "No clipboard image found; text/path paste is unchanged ({error})"
            ));
            HandledAppEvent::redraw()
        }
        AppEvent::AssistantDelta(delta) => {
            app.spinner.mark_responding(delta.chars().count());
            let redraw = app.mark_streaming_delta_redraw_seeded();
            app.enqueue_streaming_text_delta(delta);
            if redraw {
                HandledAppEvent::redraw()
            } else {
                HandledAppEvent::quiet()
            }
        }
        AppEvent::AssistantThinkingDelta(text) => {
            app.spinner.mark_thinking(text.chars().count());
            let redraw = app.mark_streaming_delta_redraw_seeded();
            let drained_pending_text = app.drain_pending_streaming_text_all();
            app.append_streaming_thinking(text);
            if redraw || drained_pending_text {
                HandledAppEvent::redraw()
            } else {
                HandledAppEvent::quiet()
            }
        }
        AppEvent::ToolInputProgress { name, chars } => {
            app.commit_streaming_thinking_summary();
            app.spinner.mark_tool_input(&name, chars);
            if chars == 0 {
                HandledAppEvent::redraw_and_flush()
            } else {
                HandledAppEvent::redraw()
            }
        }
        AppEvent::ToolInputPreview { id, preview } => {
            app.push_write_input_preview(id, preview);
            HandledAppEvent::redraw()
        }
        AppEvent::ToolPathPreview {
            generation,
            attempt_id,
            id,
            path,
        } => {
            app.path_previews.update(generation, attempt_id, id, path);
            HandledAppEvent::redraw()
        }
        AppEvent::AssistantMessageStarted => {
            app.open_subagent_panel = None;
            app.spinner.mark_requesting();
            app.start_streaming_message();
            HandledAppEvent::redraw()
        }
        AppEvent::AssistantMessageDone => {
            // The engine committed the assistant message and latest provider usage before
            // emitting this event. Refresh immediately so context-left does not retain the
            // previous request's value throughout a later long-running tool call.
            app.refresh_engine_metadata(engine);
            app.mark_streaming_message_done_pending();
            let finished = app.finish_streaming_message_if_ready();
            if finished || app.streaming_message_done_pending {
                HandledAppEvent::redraw()
            } else {
                HandledAppEvent::quiet()
            }
        }
        AppEvent::FrameTick => {
            let agent_picker_refreshed = slash::refresh_agent_picker(app, engine);
            let agent_view_refreshed = app.refresh_agent_view_transcript(engine, false).await;
            let transient_status_redraw = app.clear_expired_transient_status_at(Instant::now());
            let spinner_redraw = app.spinner.tick();
            let presented = app.drain_pending_streaming_text_tick();
            let committed = app.is_loading && app.commit_streaming_text_tick();
            let finalized = app.finish_streaming_message_if_ready();
            let deferred_finish = if app.ready_to_complete_deferred_turn_finish() {
                let handle = app.take_deferred_turn_finish_handle();
                Some(complete_finished_turn(app, engine, tx, handle))
            } else {
                None
            };
            let live_stream_redraw = app.is_loading
                || app.active_turn.is_some()
                || !app.streaming_text_pending.is_empty()
                || app.streaming_message_done_pending;
            let background_status_redraw = app.has_running_background_job();
            let mut handled = if agent_view_refreshed
                // Even an unchanged snapshot needs another draw to rearm child polling.
                || app.agent_view.is_some()
                || agent_picker_refreshed
                || app.copy_needs_tick()
                || app.navigation_needs_tick()
                || transient_status_redraw
                || spinner_redraw
                || presented
                || committed
                || finalized
                || live_stream_redraw
                || background_status_redraw
            {
                HandledAppEvent::redraw()
            } else {
                HandledAppEvent::quiet()
            };
            if let Some(deferred_finish) = deferred_finish {
                handled.merge(deferred_finish);
            }
            handled
        }
        AppEvent::ToolUseStarted { id, name, input } => {
            if is_subagent_tool_name(&name) {
                app.push_subagent_pending(id, name, input);
            } else {
                app.open_subagent_panel = None;
                if is_send_message_tool_name(&name) {
                    app.pending_send_message_inputs
                        .insert(id.clone(), input.clone());
                }
                app.push_tool_running(id, name, input);
            }
            HandledAppEvent::redraw_and_flush()
        }
        AppEvent::ToolResult {
            id,
            name,
            text,
            is_error,
        } => {
            if name.eq_ignore_ascii_case("bash") {
                app.update_background_job_lifetime_from_tool_result(&text);
            }
            if is_send_message_tool_name(&name) {
                let result = parse_subagent_result(&text, is_error);
                let input = app
                    .pending_send_message_inputs
                    .remove(&id)
                    .unwrap_or_default();
                if result.status == "resuming" {
                    app.convert_running_tool_to_subagent_panel(id.clone(), name.clone(), input);
                }
                if result.queued
                    && let (Some(agent_id), Some(message_id)) =
                        (result.agent_id.as_deref(), result.message_id.as_deref())
                {
                    app.queue_subagent_steer_in_panel(
                        agent_id,
                        message_id,
                        result.queue_position.unwrap_or(1),
                    );
                }
            }
            let belongs_to_subagent_panel = app
                .subagent_panels
                .values()
                .any(|panel| panel.has_tool_call(&id));
            if belongs_to_subagent_panel {
                app.finish_subagent_tool_call(&id, &text, is_error);
            } else {
                app.push_tool_done(id, name, text, is_error);
            }
            app.refresh_engine_metadata(engine);
            HandledAppEvent::redraw()
        }
        AppEvent::PermissionRequest {
            tool_name,
            description,
            input,
            risk,
            detail_lines,
            response_tx,
        } => {
            app.enqueue_permission_dialog(PermissionDialog {
                tool_name,
                description,
                input,
                risk,
                detail_lines,
                response_tx,
                selected: 0,
            });
            HandledAppEvent::redraw()
        }
        AppEvent::UserQuestionRequest {
            request,
            response_tx,
        } => {
            let states = question_dialog_initial_states(&request);
            let current = states.first().cloned().unwrap_or_default();
            app.enqueue_question_dialog(QuestionDialog {
                request,
                response_tx,
                states,
                selected: current.selected,
                cursor: current.cursor,
                scroll_top: current.scroll_top,
                focused: 0,
            });
            HandledAppEvent::redraw()
        }
        AppEvent::Error(err) => {
            app.path_previews.clear();
            app.push_message(MessageRole::System, format!("Error: {}", err));
            HandledAppEvent::redraw()
        }
        AppEvent::Fatal(err) => {
            app.path_previews.clear();
            append_repl_exit_diagnostic(engine, "fatal", &err);
            app.push_message(MessageRole::System, format!("Fatal: {}", err));
            HandledAppEvent::action(UserAction::Quit)
        }
        AppEvent::SystemNotice(text) => {
            app.push_message(MessageRole::System, text);
            HandledAppEvent::redraw()
        }
        AppEvent::MoaReference {
            label,
            text,
            index,
            count,
        } => {
            app.push_message(
                MessageRole::System,
                format_moa_reference_message(&label, &text, index, count),
            );
            HandledAppEvent::redraw()
        }
        AppEvent::MoaAggregating { aggregator } => {
            app.push_message(
                MessageRole::System,
                format!("MoA acting model: {aggregator}"),
            );
            HandledAppEvent::redraw()
        }
        AppEvent::MoaPlanProgress {
            message,
            completed,
            total,
        } => {
            app.foreground_operation_label = Some(if total > 0 {
                format!("{message} ({completed}/{total})")
            } else {
                message
            });
            HandledAppEvent::redraw()
        }
        AppEvent::TurnStarted => {
            app.refresh_engine_metadata(engine);
            app.mark_turn_started();
            HandledAppEvent::redraw()
        }
        AppEvent::TurnSteerApplied { id } => {
            if app.apply_pending_turn_steer(id) {
                app.spinner.mark_requesting();
                HandledAppEvent::redraw_and_flush()
            } else {
                warn!(
                    steer_id = id,
                    "received applied steer without matching TUI input"
                );
                HandledAppEvent::quiet()
            }
        }
        AppEvent::ManualCompactionFinished {
            did_compact,
            pre_compact_tokens,
            post_compact_tokens,
        } => {
            app.refresh_engine_metadata(engine);
            if did_compact {
                let message = if post_compact_tokens < pre_compact_tokens {
                    format!(
                        "Context compaction completed ({} -> {} tokens).",
                        pre_compact_tokens, post_compact_tokens
                    )
                } else {
                    format!(
                        "Context compaction completed; model context is now {} tokens.",
                        post_compact_tokens
                    )
                };
                app.push_message(MessageRole::System, message);
            } else {
                app.push_message(
                    MessageRole::System,
                    "Context compaction skipped: not enough older conversation to compact.",
                );
            }
            app.snap_to_bottom();
            HandledAppEvent::redraw()
        }
        AppEvent::ManualCompactionFailed { error } => {
            app.push_message(
                MessageRole::System,
                format!("Context compaction failed: {error}"),
            );
            app.snap_to_bottom();
            HandledAppEvent::redraw()
        }
        AppEvent::MoaPlanFinished {
            final_path,
            draft_count,
            failed_count,
        } => {
            app.refresh_engine_metadata(engine);
            app.replace_transcript_from_history(&engine.state.messages());
            app.push_message(
                MessageRole::System,
                format!(
                    "MoA plan completed: {} drafts, {} failed planner(s). Final: {}",
                    draft_count,
                    failed_count,
                    final_path.display()
                ),
            );
            app.snap_to_bottom();
            HandledAppEvent::redraw()
        }
        AppEvent::MoaPlanFailed { error } => {
            app.push_message(MessageRole::System, format!("MoA plan failed: {error}"));
            app.snap_to_bottom();
            HandledAppEvent::redraw()
        }
        AppEvent::SideQuestionCompleted { id, answer } => {
            if let Some(overlay) = app.side_question_overlay.as_mut()
                && overlay.id == id
            {
                overlay.status = SideQuestionStatus::Answered(answer);
                overlay.scroll = 0;
            }
            HandledAppEvent::redraw()
        }
        AppEvent::SideQuestionFailed { id, error } => {
            if let Some(overlay) = app.side_question_overlay.as_mut()
                && overlay.id == id
            {
                overlay.status = SideQuestionStatus::Failed(error);
                overlay.scroll = 0;
            }
            HandledAppEvent::redraw()
        }
        AppEvent::TurnFinished => {
            app.defer_unapplied_turn_steers();
            let handle = app.finish_turn_state();
            if app.should_defer_turn_finish_for_streaming() {
                app.defer_turn_finish_until_streaming_drained(handle);
                HandledAppEvent::redraw()
            } else {
                complete_finished_turn(app, engine, tx, handle)
            }
        }
        AppEvent::HistoryChanged => {
            app.refresh_engine_metadata(engine);
            let messages = engine.state.messages();
            app.replace_transcript_from_history(&messages);
            app.reconcile_subagent_panels_from_engine(engine);
            HandledAppEvent::redraw()
        }
        AppEvent::TurnWakeRequested => HandledAppEvent::action(UserAction::TryStartTurn),
        AppEvent::BackgroundFollowupRequested {
            ids,
            events,
            summary,
        } => {
            enqueue_background_followup(app, ids, events, summary);
            HandledAppEvent::action(UserAction::TryStartTurn)
        }
        AppEvent::BackgroundJobStarted {
            id,
            description,
            continuation,
        } => {
            // Background status hints are intentionally not pushed to the
            // transcript. They are surfaced via compact status UI so the user
            // does not mistake them for assistant output. Sub-agent completions
            // still reach the model through the engine's notification path;
            // tool background tasks are polled explicitly via TaskOutput.
            if continuation {
                app.detach_subagent_routing_for_continuation(&id);
            }
            app.record_background_job_hint(BackgroundJobHint {
                id,
                description,
                state: BackgroundJobHintState::Running,
                error: None,
                started_at: Some(std::time::Instant::now()),
            });
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobAssociated {
            id,
            tool_call_id,
            run_in_background,
        } => {
            app.associate_subagent_panel(&id, &tool_call_id, run_in_background);
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobPromoted { id } => {
            app.promote_subagent_panel(&id);
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobProgress {
            id,
            message,
            detail,
            current,
            total,
        } => {
            let hint_changed =
                app.update_background_job_progress(&id, message.clone(), current, total);
            let panel_changed = app.update_subagent_panel_progress(
                &id,
                &message,
                detail.as_deref(),
                current,
                total,
            );
            if hint_changed || panel_changed {
                HandledAppEvent::redraw()
            } else {
                HandledAppEvent::quiet()
            }
        }
        AppEvent::SubagentSteerApplied {
            id,
            message_id,
            queue_depth,
        } => {
            app.apply_subagent_steer_to_panel(&id, &message_id, queue_depth);
            app.finish_agent_view_steer(&id, &message_id);
            app.refresh_agent_view_transcript(engine, true).await;
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobReconciledRunning {
            id,
            detail,
            current,
            total,
        } => {
            app.update_subagent_panel_progress(&id, "Running", detail.as_deref(), current, total);
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobPaused { id, reason } => {
            let reason = engine
                .state
                .task(&id)
                .map(|task| orchestrate_agent_status_detail(&task))
                .unwrap_or(reason);
            app.complete_background_job_hint(
                &id,
                BackgroundJobHintState::Paused,
                Some(reason.clone()),
            );
            app.pause_subagent_panel(&id, "Paused", Some(&reason));
            if !app.is_loading && !app.has_running_background_job() {
                app.spinner.stop();
            }
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobHalted { id, reason } => {
            let reason = engine
                .state
                .task(&id)
                .map(|task| orchestrate_agent_status_detail(&task))
                .unwrap_or(reason);
            app.complete_background_job_hint(
                &id,
                BackgroundJobHintState::Halted,
                Some(reason.clone()),
            );
            app.finish_subagent_panel(&id, SubagentPhase::Halted, reason);
            app.flush_terminal_subagent_panel_if_idle();
            if !app.is_loading && !app.has_running_background_job() {
                app.spinner.stop();
            }
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobCompleted { id, summary } => {
            app.complete_background_job_hint(&id, BackgroundJobHintState::Completed, None);
            if let Some(summary) = summary.as_deref() {
                app.update_subagent_panel_progress(&id, "Completed", Some(summary), None, None);
            }
            app.finish_subagent_panel(&id, SubagentPhase::Completed, "Completed");
            app.flush_terminal_subagent_panel_if_idle();
            if !app.is_loading && !app.has_running_background_job() {
                app.spinner.stop();
            }
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobFailed { id, error } => {
            if error.trim() == "cancelled by user" {
                app.complete_background_job_hint(&id, BackgroundJobHintState::Completed, None);
                app.finish_subagent_panel(&id, SubagentPhase::Cancelled, "Cancelled");
                app.flush_terminal_subagent_panel_if_idle();
                if !app.is_loading && !app.has_running_background_job() {
                    app.spinner.stop();
                }
                return HandledAppEvent::redraw();
            }
            // Update an existing hint if present, otherwise record a new
            // failed entry so status surfaces can expose the failure.
            if !app.complete_background_job_hint(
                &id,
                BackgroundJobHintState::Failed,
                Some(error.clone()),
            ) {
                app.record_background_job_hint(BackgroundJobHint {
                    id: id.clone(),
                    description: format!("error: {error}"),
                    state: BackgroundJobHintState::Failed,
                    error: Some(error.clone()),
                    started_at: None,
                });
            }
            app.finish_subagent_panel(&id, SubagentPhase::Failed, error);
            app.flush_terminal_subagent_panel_if_idle();
            if !app.is_loading && !app.has_running_background_job() {
                app.spinner.stop();
            }
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobCancelled { id } => {
            app.complete_background_job_hint(&id, BackgroundJobHintState::Cancelled, None);
            app.finish_subagent_panel(&id, SubagentPhase::Cancelled, "Cancelled");
            app.flush_terminal_subagent_panel_if_idle();
            if !app.is_loading && !app.has_running_background_job() {
                app.spinner.stop();
            }
            HandledAppEvent::redraw()
        }
    }
}
