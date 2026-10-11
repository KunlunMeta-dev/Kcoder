//! User action dispatch into engine and local state transitions.

use super::*;

pub(super) async fn handle_user_action(
    action: UserAction,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> Result<bool> {
    match action {
        UserAction::Quit => {
            if let Some(handle) = app.abort_turn_for_shutdown() {
                match handle.await {
                    Err(error) if !error.is_cancelled() => {
                        warn!(%error, "turn task failed during shutdown");
                    }
                    _ => {}
                }
            }
            Ok(true)
        }
        UserAction::Suspend => Ok(false),
        UserAction::Submit(submitted) => {
            if let Some(agent_id) = app.viewed_agent_id().map(str::to_string) {
                handle_agent_view_submitted_message(submitted, &agent_id, engine, app, tx).await
            } else {
                handle_submitted_message(submitted, engine, app, tx, prompt).await
            }
        }
        UserAction::RunShellCommand {
            command,
            history_text,
        } => {
            if app.has_interruptible_turn() {
                if !app.enqueue_user_message_for_turn(QueuedUserMessage::from_shell_prompt(
                    history_text,
                )) {
                    let _ = tx.send(AppEvent::SystemNotice(format!(
                        "Input queue is full ({USER_MESSAGE_QUEUE_MAX} pending). Use /queue clear to discard queued prompts."
                    )));
                }
                return Ok(false);
            }
            if command.is_empty() {
                app.push_user_shell_help();
                let outcome = try_start_next_turn(engine, app, tx, prompt).await?;
                return Ok(matches!(outcome, StartTurnOutcome::Quit));
            }
            start_user_shell_command(engine, app, tx, prompt, command);
            Ok(false)
        }
        UserAction::SlashCommand(command) => {
            let (slash_name, _) = parse_slash_input(&command);
            let is_side_question = slash_name.eq_ignore_ascii_case("/btw");
            let is_immediate_control = matches!(
                slash_name.to_ascii_lowercase().as_str(),
                "/agent" | "/stop" | "/clean" | "/outline" | "/jump"
            );
            if app.has_interruptible_turn() && !is_side_question && !is_immediate_control {
                if !app
                    .enqueue_user_message_for_turn(QueuedUserMessage::from_slash_command(command))
                {
                    let _ = tx.send(AppEvent::SystemNotice(format!(
                        "Input queue is full ({USER_MESSAGE_QUEUE_MAX} pending). Use /queue clear to discard queued prompts."
                    )));
                }
                return Ok(false);
            }
            match handle_slash_command(&command, app, engine).await {
                Some(UserAction::Quit) => return Ok(true),
                Some(UserAction::Submit(submitted)) => {
                    handle_submitted_message(submitted, engine, app, tx, prompt).await?;
                }
                Some(UserAction::CompactConversation) => {
                    start_manual_compaction(engine, app, tx);
                }
                Some(UserAction::StartSideQuestion(question)) => {
                    start_side_question(engine, app, tx, question);
                }
                Some(UserAction::StartMoaPlan(request)) => {
                    start_moa_plan(engine, app, tx, request);
                }
                _ => {}
            }
            app.refresh_engine_metadata(engine);
            Ok(false)
        }
        UserAction::CompactConversation => {
            start_manual_compaction(engine, app, tx);
            Ok(false)
        }
        UserAction::StartSideQuestion(question) => {
            start_side_question(engine, app, tx, question);
            Ok(false)
        }
        UserAction::StartMoaPlan(request) => {
            start_moa_plan(engine, app, tx, request);
            Ok(false)
        }
        UserAction::ResumeSession(path) => {
            resume_session_from_history_path(&path, engine, app);
            Ok(false)
        }
        UserAction::ConfirmGoalReplacement {
            objective,
            token_budget,
            mode,
            verification_kind,
        } => {
            match prepare_goal_objective(engine.state.cwd(), objective.trim()) {
                Ok(prepared) => {
                    let context_snapshot =
                        kcoder_state::goal_context_snapshot(&engine.state.messages());
                    let verifier_selection = if mode.is_strict() {
                        goal_pro_verifier_selection(engine)
                    } else {
                        GoalVerifierSelection::default()
                    };
                    let goal = match engine
                        .state
                        .set_goal_prepared_with_mode_and_verification_and_verifier(
                            prepared.objective.clone(),
                            prepared.objective_file.clone(),
                            token_budget,
                            mode,
                            verification_kind,
                            verifier_selection,
                        ) {
                        Ok(goal) => goal,
                        Err(error) => {
                            app.push_message(
                                MessageRole::System,
                                format!("Failed to replace goal: {error:#}"),
                            );
                            return Ok(false);
                        }
                    };
                    let goal = if mode.is_strict() {
                        engine
                            .state
                            .set_goal_context_snapshot(context_snapshot)
                            .unwrap_or(goal)
                    } else {
                        goal
                    };
                    let goal = if mode.is_strict() {
                        match kcoder_engine::agent::ensure_goal_pro_workspace_baseline(
                            &engine.state,
                            &goal,
                        )
                        .await
                        {
                            Ok(goal) => goal,
                            Err(error) => {
                                engine.state.clear_goal();
                                app.push_message(
                                    MessageRole::System,
                                    format!(
                                        "Failed to capture the replacement Goal Pro verifier baseline; the replacement goal was cleared: {error}"
                                    ),
                                );
                                return Ok(false);
                            }
                        }
                    } else {
                        goal
                    };
                    let materialized = prepared
                        .objective_file
                        .as_ref()
                        .map(|path| format!(" Objective saved to {}.", path.display()))
                        .unwrap_or_default();
                    app.refresh_engine_metadata(engine);
                    app.push_message(
                        MessageRole::System,
                        format!(
                            "{} replaced{} Active objective: {}",
                            if mode.is_arrangement() {
                                "UltGoal"
                            } else if mode.is_strict() {
                                "Goal Pro"
                            } else {
                                "Goal"
                            },
                            materialized,
                            truncate_display_text(&goal.objective, 120)
                        ),
                    );
                }
                Err(error) => {
                    app.push_message(
                        MessageRole::System,
                        format!("Failed to prepare goal objective: {error:#}"),
                    );
                }
            }
            Ok(false)
        }
        UserAction::ClearUi => {
            app.clear_conversation_ui(engine);
            Ok(false)
        }
        UserAction::CopyLastResponse => {
            app.copy_last_assistant_response();
            Ok(false)
        }
        UserAction::PasteClipboardImage => {
            if app.clipboard_image_paste_in_flight {
                app.set_transient_status("Clipboard image paste is already in progress");
                return Ok(false);
            }
            app.clipboard_image_paste_in_flight = true;
            app.set_transient_status("Reading image from clipboard…");
            let tx = tx.clone();
            tokio::spawn(async move {
                let event = match tokio::task::spawn_blocking(clipboard_image::read_clipboard_image)
                    .await
                {
                    Ok(Ok(image)) => AppEvent::ClipboardImageReady(image),
                    Ok(Err(error)) => AppEvent::ClipboardImageFailed(error.to_string()),
                    Err(error) => AppEvent::ClipboardImageFailed(format!(
                        "clipboard image worker failed: {error}"
                    )),
                };
                let _ = tx.send_ordered(event).await;
            });
            Ok(false)
        }
        UserAction::OpenExternalEditor => {
            app.open_external_editor().await;
            Ok(false)
        }
        UserAction::EditPreviousMessage => {
            app.edit_previous_message(engine);
            Ok(false)
        }
        UserAction::ToggleRawOutput => {
            app.set_raw_output_mode(!app.raw_output_mode());
            Ok(false)
        }
        UserAction::AdjustReasoning(direction) => {
            app.adjust_reasoning_effort(engine, direction);
            Ok(false)
        }
        UserAction::CompleteDeferredTurn => {
            let handle = app.take_deferred_turn_finish_handle();
            complete_finished_turn(app, engine, tx, handle);
            Ok(false)
        }
        UserAction::Interrupt => {
            if let Some(goal) = engine.state.goal()
                && goal.status == GoalStatus::Active
            {
                engine.state.update_goal_status(GoalStatus::Paused);
                app.refresh_engine_metadata(engine);
                let command = goal_command_for_goal(&goal);
                let name = goal_display_name(&goal);
                let _ = tx.send(AppEvent::SystemNotice(format!(
                        "{name} paused by interrupt. Use {command} resume to continue, {command} status to inspect, or {command} clear to discard. Objective: {}",
                        truncate_display_text(&goal.objective, 160)
                    )));
            }
            Ok(false)
        }
        UserAction::ShortenToolWait => {
            engine.shorten_waiting_tools();
            Ok(false)
        }
        UserAction::TryStartTurn => {
            let outcome = try_start_next_turn(engine, app, tx, prompt).await?;
            Ok(matches!(outcome, StartTurnOutcome::Quit))
        }
    }
}
