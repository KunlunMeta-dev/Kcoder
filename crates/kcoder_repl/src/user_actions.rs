//! Submitted input routing and agent-view steering.

use super::*;

#[cfg(test)]
mod tests;

struct PendingInputPreparation {
    id: u64,
    submitted: SubmittedMessage,
    owner: kcoder_state::AppStateLifecycleIdentity,
    engine: QueryEngine,
    tx: AppEventSender,
}

struct ActiveInputPreparation {
    id: u64,
    submitted: SubmittedMessage,
    owner: kcoder_state::AppStateLifecycleIdentity,
    cancel: CancellationToken,
    handle: Option<JoinHandle<()>>,
}

pub(super) struct DeferredInputResult {
    pub(super) id: u64,
    pub(super) result: std::result::Result<Message, String>,
    pub(super) hook_messages: Vec<(String, bool)>,
    retry_at: Instant,
}

impl Drop for ActiveInputPreparation {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Owns the ordered preparation tasks and any cancelled file reads still settling.
#[derive(Default)]
pub(super) struct InputPreparationQueue {
    next_id: u64,
    pending: VecDeque<PendingInputPreparation>,
    active: Option<ActiveInputPreparation>,
    retired: Vec<JoinHandle<()>>,
    deferred: Option<DeferredInputResult>,
}

impl InputPreparationQueue {
    fn reserve_id(&mut self) -> Result<u64> {
        self.retired.retain(|handle| !handle.is_finished());
        anyhow::ensure!(
            self.retired.len() < USER_MESSAGE_QUEUE_MAX,
            "previous input preparations are still stopping"
        );
        self.next_id = self
            .next_id
            .checked_add(1)
            .context("input identity exhausted")?;
        Ok(self.next_id)
    }

    pub(super) fn is_pending(&self) -> bool {
        self.active.is_some() || !self.pending.is_empty()
    }

    pub(super) fn has_deferred(&self) -> bool {
        self.deferred.is_some()
    }

    pub(super) fn take_due(&mut self, now: Instant) -> Option<DeferredInputResult> {
        if self
            .deferred
            .as_ref()
            .is_some_and(|item| item.retry_at <= now)
        {
            self.deferred.take()
        } else {
            None
        }
    }

    fn retire(&mut self, mut active: ActiveInputPreparation) {
        active.cancel.cancel();
        if let Some(handle) = active.handle.take() {
            self.retired.push(handle);
        }
        self.retired.retain(|handle| !handle.is_finished());
    }

    pub(super) fn cancel_one(&mut self, id: u64) {
        if self.deferred.as_ref().is_some_and(|item| item.id == id) {
            self.deferred = None;
        }
        self.pending.retain(|pending| pending.id != id);
        if self.active.as_ref().is_some_and(|active| active.id == id) {
            let active = self.active.take().expect("active input checked above");
            self.retire(active);
        }
        self.start_next();
    }

    pub(super) fn cancel_all(&mut self) {
        self.deferred = None;
        self.pending.clear();
        if let Some(active) = self.active.take() {
            self.retire(active);
        }
    }

    pub(super) fn has_unsettled(&mut self) -> bool {
        self.retired.retain(|handle| !handle.is_finished());
        self.active.is_some() || !self.retired.is_empty()
    }

    #[cfg(all(test, unix))]
    pub(super) async fn settle(&mut self) {
        self.cancel_all();
        for handle in std::mem::take(&mut self.retired) {
            let _ = handle.await;
        }
    }

    pub(super) async fn settle_until(&mut self, deadline: tokio::time::Instant) -> bool {
        self.cancel_all();
        for mut handle in std::mem::take(&mut self.retired) {
            if tokio::time::timeout_at(deadline, &mut handle)
                .await
                .is_err()
            {
                // Cancellation is scoped to this preparation task. Hook and
                // image readers retain their own resource ownership.
                handle.abort();
                self.retired.push(handle);
            }
        }
        self.retired.is_empty()
    }

    fn start_next(&mut self) {
        self.retired.retain(|handle| !handle.is_finished());
        if self.active.is_some() {
            return;
        }
        let Some(job) = self.pending.pop_front() else {
            return;
        };
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task_submitted = job.submitted.clone();
        let id = job.id;
        let task_owner = job.owner.clone();
        let handle = tokio::spawn(async move {
            let prepared = std::panic::AssertUnwindSafe(async {
                let owner_matches = loop {
                    match job.engine.state.try_check_lifecycle_identity(&task_owner) {
                        Ok(Some(value)) => break value,
                        Err(_) => break false,
                        Ok(None) => tokio::select! {
                            biased;
                            _ = task_cancel.cancelled() => break false,
                            _ = tokio::time::sleep(Duration::from_millis(80)) => {},
                        },
                    }
                };
                if owner_matches {
                    prepare_submitted_input(&job.engine, task_submitted, task_cancel.clone()).await
                } else {
                    (
                        Vec::new(),
                        Err("Input belongs to a previous session.".into()),
                    )
                }
            });
            let (hook_messages, result) = futures::FutureExt::catch_unwind(prepared)
                .await
                .unwrap_or_else(|_| {
                    (
                        Vec::new(),
                        Err("Input preparation failed unexpectedly.".into()),
                    )
                });
            if !task_cancel.is_cancelled() {
                tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => {},
                    _ = job.tx.send_ordered(AppEvent::InputPreparationFinished {
                        id, result, hook_messages,
                    }) => {},
                }
            }
        });
        self.active = Some(ActiveInputPreparation {
            id,
            submitted: job.submitted,
            owner: job.owner,
            cancel,
            handle: Some(handle),
        });
    }
}

async fn prepare_submitted_input(
    engine: &QueryEngine,
    submitted: SubmittedMessage,
    cancel: CancellationToken,
) -> (Vec<(String, bool)>, std::result::Result<Message, String>) {
    if !submitted.images.is_empty() {
        loop {
            let vision = engine
                .settings
                .try_read()
                .ok()
                .map(|settings| settings.model_capabilities.vision);
            if let Some(vision) = vision {
                if !vision {
                    return (
                        Vec::new(),
                        Err(
                            "[image input blocked] The selected model does not support images."
                                .into(),
                        ),
                    );
                }
                break;
            }
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return (Vec::new(), Err("Input preparation cancelled.".into())),
                _ = tokio::time::sleep(Duration::from_millis(80)) => {},
            }
        }
    }
    let hooks = tokio::select! {
        biased;
        _ = cancel.cancelled() => return (Vec::new(), Err("Input preparation cancelled.".into())),
        hooks = engine.run_user_prompt_submit_hooks(&submitted.text) => hooks,
    };
    let (events, modified, blocking_error) = hooks;
    let hook_messages = events
        .into_iter()
        .filter_map(|event| match event {
            EngineEvent::HookMessage { text, is_error } => Some((text, is_error)),
            _ => None,
        })
        .collect::<Vec<_>>();
    if let Some(error) = blocking_error {
        return (hook_messages, Err(format!("[hook blocked] {error}")));
    }
    let text = modified.unwrap_or_else(|| submitted.text.clone());
    if submitted.images.is_empty() {
        return (
            hook_messages,
            submitted
                .to_model_message(text)
                .map_err(|error| format!("[image input error] {error}")),
        );
    }
    let result = crate::input_image_pool::prepare(submitted, text, cancel)
        .await
        .map_err(|error| format!("[image input error] {error}"));
    (hook_messages, result)
}

fn restore_unaccepted_input(app: &mut ReplApp, submitted: &SubmittedMessage) {
    app.prefill_input(submitted.visible_text.clone());
    app.local_image_attachments = submitted.images.clone();
    app.remote_image_urls = submitted.remote_image_urls.clone();
    app.pending_pastes = submitted.pending_pastes.clone();
    app.sync_composer_sidecars();
}

pub(super) async fn handle_submitted_message(
    submitted: SubmittedMessage,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> Result<bool> {
    if app.has_cancelled_input_barrier() {
        restore_unaccepted_input(app, &submitted);
        app.show_cancelled_input_notice();
        return Ok(false);
    }
    // Reserve the original position before running hooks or reading files.
    if app.pending_input_count() >= USER_MESSAGE_QUEUE_MAX {
        restore_unaccepted_input(app, &submitted);
        let _ = tx.send(AppEvent::SystemNotice(format!(
            "Input queue is full ({USER_MESSAGE_QUEUE_MAX} pending). Use /queue clear to discard queued prompts."
        )));
        return Ok(false);
    }
    let Some(owner) = app.input_session_owner.clone() else {
        restore_unaccepted_input(app, &submitted);
        let _ = tx.send(AppEvent::SystemNotice(
            "Session is busy; your input was kept for retry.".into(),
        ));
        return Ok(false);
    };
    let id = match app.input_preparation.reserve_id() {
        Ok(id) => id,
        Err(error) => {
            restore_unaccepted_input(app, &submitted);
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "Input is not ready: {error}"
            )));
            return Ok(false);
        }
    };
    let mut queued =
        QueuedUserMessage::from_submitted(Message::user_text(&submitted.text), &submitted);
    queued.action = QueuedInputAction::Preparing(id);
    app.user_message_queue.push_back(queued);
    app.input_preparation
        .pending
        .push_back(PendingInputPreparation {
            id,
            submitted,
            owner,
            engine: engine.clone(),
            tx: tx.clone(),
        });
    app.input_preparation.start_next();
    app.sync_input_preparation_indicator();
    app.force_next_viewport_redraw();
    let _ = prompt;
    Ok(false)
}

pub(super) async fn complete_submitted_message(
    id: u64,
    result: std::result::Result<Message, String>,
    hook_messages: Vec<(String, bool)>,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> Result<bool> {
    if app
        .input_preparation
        .active
        .as_ref()
        .is_none_or(|active| active.id != id)
    {
        return Ok(false);
    }
    let active = app
        .input_preparation
        .active
        .as_ref()
        .expect("active input checked above");
    let original_owner = active.owner.clone();
    let has_images = !active.submitted.images.is_empty();
    let owner_matches = engine
        .state
        .try_check_lifecycle_identity(&active.owner)
        .unwrap_or(Some(false));
    let vision = if owner_matches == Some(true) && result.is_ok() && has_images {
        engine
            .settings
            .try_read()
            .ok()
            .map(|settings| settings.model_capabilities.vision)
    } else {
        Some(true)
    };
    if owner_matches.is_none() || vision.is_none() {
        app.input_preparation.deferred = Some(DeferredInputResult {
            id,
            result,
            hook_messages,
            retry_at: Instant::now() + Duration::from_millis(80),
        });
        app.force_next_viewport_redraw();
        return Ok(false);
    }
    if app.has_running_side_questions() {
        app.input_preparation.deferred = Some(DeferredInputResult {
            id,
            result,
            hook_messages,
            retry_at: Instant::now() + Duration::from_millis(80),
        });
        app.force_next_viewport_redraw();
        return Ok(false);
    }
    let steer = if owner_matches == Some(true)
        && vision == Some(true)
        && app.turn_lifecycle_in_progress()
    {
        if let Ok(message) = &result {
            let steer_id = app.next_turn_steer_id();
            Some((
                steer_id,
                engine.try_enqueue_turn_steer_for_lifecycle(
                    &original_owner,
                    steer_id,
                    message.clone(),
                ),
            ))
        } else {
            None
        }
    } else {
        None
    };
    if matches!(steer, Some((_, kcoder_engine::GuardedTurnSteer::Busy))) {
        app.input_preparation.deferred = Some(DeferredInputResult {
            id,
            result,
            hook_messages,
            retry_at: Instant::now() + Duration::from_millis(80),
        });
        app.force_next_viewport_redraw();
        return Ok(false);
    }
    let mut active = app
        .input_preparation
        .active
        .take()
        .expect("active input checked above");
    if let Some(handle) = active.handle.take() {
        app.input_preparation.retired.push(handle);
    }
    let position = app
        .user_message_queue
        .iter()
        .position(|message| message.action == QueuedInputAction::Preparing(id));
    let valid_owner = owner_matches == Some(true)
        && !matches!(
            steer,
            Some((_, kcoder_engine::GuardedTurnSteer::OwnerChanged))
        );
    let submitted = active.submitted.clone();
    drop(active);
    let Some(position) = position else {
        app.input_preparation.start_next();
        app.sync_input_preparation_indicator();
        return Ok(false);
    };
    if !valid_owner {
        app.user_message_queue[position].action = QueuedInputAction::Held;
        app.push_message(
            MessageRole::System,
            "The session changed; the input remains queued for editing or clearing.".to_string(),
        );
        app.input_preparation.start_next();
        app.sync_input_preparation_indicator();
        app.force_next_viewport_redraw();
        return Ok(false);
    }
    for (text, is_error) in hook_messages {
        let _ = tx.send(AppEvent::SystemNotice(if is_error {
            format!("[hook error] {text}")
        } else {
            format!("[hook] {text}")
        }));
    }
    let model_message = match result {
        Ok(message) if vision == Some(true) => message,
        Ok(_) => {
            app.user_message_queue.remove(position);
            let _ = tx.send(AppEvent::SystemNotice(
                "[image input blocked] The selected model does not support images.".into(),
            ));
            let outcome = try_start_next_turn(engine, app, tx, prompt).await;
            app.input_preparation.start_next();
            app.sync_input_preparation_indicator();
            let outcome = outcome?;
            return Ok(matches!(outcome, StartTurnOutcome::Quit));
        }
        Err(error) => {
            app.user_message_queue.remove(position);
            let _ = tx.send(AppEvent::SystemNotice(error));
            let outcome = try_start_next_turn(engine, app, tx, prompt).await;
            app.input_preparation.start_next();
            app.sync_input_preparation_indicator();
            let outcome = outcome?;
            return Ok(matches!(outcome, StartTurnOutcome::Quit));
        }
    };
    let mut queued = QueuedUserMessage::from_submitted(model_message, &submitted);
    queued.owner = Some(original_owner);
    if let Some((steer_id, outcome)) = steer {
        match outcome {
            kcoder_engine::GuardedTurnSteer::Queued => {
                app.user_message_queue.remove(position);
                app.track_pending_turn_steer(steer_id, queued);
                app.input_preparation.start_next();
                app.sync_input_preparation_indicator();
                return Ok(false);
            }
            kcoder_engine::GuardedTurnSteer::NoActiveTurn => {
                // Manual compaction, foreground shells, and shutdown races are not steerable;
                // retain the input as a regular request for the next turn.
            }
            kcoder_engine::GuardedTurnSteer::QueueFull { max } => {
                app.user_message_queue[position].action = QueuedInputAction::Held;
                let _ = tx.send(AppEvent::SystemNotice(format!(
                    "Turn steer queue is full ({max} pending); the input remains queued for editing or clearing."
                )));
                app.input_preparation.start_next();
                app.sync_input_preparation_indicator();
                return Ok(false);
            }
            kcoder_engine::GuardedTurnSteer::Busy
            | kcoder_engine::GuardedTurnSteer::OwnerChanged => {
                unreachable!("handled before removing the input owner")
            }
        }
    }

    // Input submitted while idle, or rejected by a non-steerable foreground
    // operation, retains next-turn queue semantics.
    app.user_message_queue[position] = queued;
    if app.foreground_operation_label.as_deref() == Some("Preparing input") {
        app.foreground_operation_label = None;
        app.spinner.stop();
    }
    let outcome = try_start_next_turn(engine, app, tx, prompt).await;
    app.input_preparation.start_next();
    app.sync_input_preparation_indicator();
    let outcome = outcome?;
    Ok(matches!(outcome, StartTurnOutcome::Quit))
}

pub(super) async fn handle_agent_view_submitted_message(
    submitted: SubmittedMessage,
    agent_id: &str,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
) -> Result<bool> {
    if app.has_unconfirmed_input() {
        restore_unaccepted_input(app, &submitted);
        app.show_unconfirmed_input_notice();
        return Ok(false);
    }
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
