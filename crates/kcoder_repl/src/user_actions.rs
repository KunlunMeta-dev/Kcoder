//! Submitted input routing and agent-view steering.

use super::*;

pub(super) async fn handle_submitted_message(
    submitted: SubmittedMessage,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> Result<bool> {
    // Run submit hooks immediately, but defer writing the message into
    // engine state until its turn is scheduled. That preserves
    // provider-required tool_use/tool_result adjacency while still
    // letting the UI show queued input right away.
    if !submitted.images.is_empty() && !engine.model_supports_vision() {
        let _ = tx.send(AppEvent::SystemNotice(format!(
            "[image input blocked] Model '{}' was auto-discovered as text-only. Add an explicit provider profile with vision capability to enable images.",
            engine.model_name()
        )));
        return Ok(false);
    }
    let text = submitted.text.clone();
    let (hook_events, modified_text, blocking_error) =
        engine.run_user_prompt_submit_hooks(&text).await;
    for ev in hook_events {
        if let EngineEvent::HookMessage { text, is_error } = ev {
            let _ = tx.send(AppEvent::SystemNotice(if is_error {
                format!("[hook error] {}", text)
            } else {
                format!("[hook] {}", text)
            }));
        }
    }
    if let Some(error) = blocking_error {
        let _ = tx.send(AppEvent::SystemNotice(format!("[hook blocked] {}", error)));
        return Ok(false);
    }
    let effective_text = modified_text.unwrap_or(text.clone());
    let model_message = match submitted.to_model_message(effective_text) {
        Ok(message) => message,
        Err(error) => {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "[image input error] {}",
                error
            )));
            return Ok(false);
        }
    };
    let queued = QueuedUserMessage::from_submitted(model_message, &submitted);
    if app.turn_lifecycle_in_progress() {
        if app.pending_input_count() >= USER_MESSAGE_QUEUE_MAX {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "Input queue is full ({USER_MESSAGE_QUEUE_MAX} pending). Use /queue clear to discard queued prompts."
            )));
            return Ok(false);
        }

        let steer_id = app.next_turn_steer_id();
        match engine.enqueue_turn_steer(steer_id, queued.model_message.clone()) {
            Ok(()) => {
                app.track_pending_turn_steer(steer_id, queued);
                return Ok(false);
            }
            Err(TurnSteerError::NoActiveTurn) => {
                // Manual compaction, foreground shells, and shutdown races are not steerable;
                // retain the input as a regular request for the next turn.
            }
            Err(TurnSteerError::QueueFull { max }) => {
                let _ = tx.send(AppEvent::SystemNotice(format!(
                    "Turn steer queue is full ({max} pending). Wait for the next model boundary."
                )));
                return Ok(false);
            }
        }
    }

    // Input submitted while idle, or rejected by a non-steerable foreground
    // operation, retains next-turn queue semantics.
    if !app.enqueue_user_message_for_turn(queued) {
        let _ = tx.send(AppEvent::SystemNotice(format!(
            "Input queue is full ({USER_MESSAGE_QUEUE_MAX} pending). Use /queue clear to discard queued prompts."
        )));
        return Ok(false);
    }

    let outcome = try_start_next_turn(engine, app, tx, prompt).await?;
    Ok(matches!(outcome, StartTurnOutcome::Quit))
}

pub(super) async fn handle_agent_view_submitted_message(
    submitted: SubmittedMessage,
    agent_id: &str,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
) -> Result<bool> {
    if !submitted.images.is_empty() || !submitted.remote_image_urls.is_empty() {
        let _ = tx.send(AppEvent::SystemNotice(
            "Agent steering currently accepts text only; attachments were not sent.".to_string(),
        ));
        return Ok(false);
    }
    let message = expand_pending_pastes(&submitted.text, &submitted.pending_pastes);
    if message.trim().is_empty() {
        let _ = tx.send(AppEvent::SystemNotice(
            "Agent steering message must not be empty.".to_string(),
        ));
        return Ok(false);
    }
    match engine.steer_subagent(agent_id, message.trim()).await {
        Ok(receipt) => {
            let status = receipt.status.as_str();
            if receipt.queued {
                let queue_position = receipt.queue_position.unwrap_or(1);
                if let Some(message_id) = receipt.message_id.as_deref() {
                    app.queue_subagent_steer_in_panel(agent_id, message_id, queue_position);
                    app.queue_agent_view_steer(agent_id, message_id, message.trim());
                }
                app.set_agent_view_steer_status(agent_id, format!("Steering queued ({status})"));
                app.set_transient_status(format!(
                    "Sending to {agent_id}: {status}, position {queue_position}"
                ));
            } else {
                let _ = tx.send(AppEvent::SystemNotice(format!(
                    "Could not steer {agent_id} ({status}): {}",
                    truncate_display_text(&receipt.next_action, 320)
                )));
            }
        }
        Err(error) => {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "Could not steer {agent_id}: {error}"
            )));
        }
    }
    Ok(false)
}
