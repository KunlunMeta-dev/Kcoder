//! Peer queue hints never grant permission or fabricate user input.
use super::*;

pub(super) struct PeerWatcher {
    cancel: CancellationToken,
    task: JoinHandle<()>,
}
impl Drop for PeerWatcher {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.task.abort();
    }
}
pub(super) fn watch(engine: &QueryEngine, tx: &AppEventSender) -> Option<PeerWatcher> {
    if !engine.has_peer_message_host() {
        return None;
    }
    let engine = engine.clone();
    let tx = tx.clone();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let task = tokio::spawn(async move {
        let mut last = None;
        let mut was_active = false;
        let mut retry_at = Instant::now();
        loop {
            tokio::select! {biased;_=stop.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(1))=>{}}
            let active = engine.turn_driver_active();
            let observer = engine.clone();
            let stamp =
                tokio::task::spawn_blocking(move || observer.peer_message_observation_stamp())
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .flatten();
            if !active && (stamp != last || was_active || Instant::now() >= retry_at) {
                if !tx.send(AppEvent::PeerMessagesAvailable) {
                    break;
                }
                retry_at = Instant::now() + Duration::from_secs(2);
            }
            last = stamp;
            was_active = active;
        }
    });
    Some(PeerWatcher { cancel, task })
}
pub(super) fn ui_allows_peer_start(app: &mut ReplApp) -> bool {
    app.user_message_queue.is_empty()
        && app.pending_background_followups.is_empty()
        && app.rejected_turn_steers.is_empty()
        && app.input.is_empty()
        && !app.has_unconfirmed_input()
        && app.input_admission.is_none()
        && app.pending_permission.is_none()
        && app.pending_question.is_none()
        && !app.has_running_side_questions()
}
struct IdleCompletion {
    tx: AppEventSender,
    transferred: bool,
    generation: u64,
}
impl Drop for IdleCompletion {
    fn drop(&mut self) {
        if !self.transferred {
            let _ = self.tx.send(AppEvent::PeerIdleFinished {
                generation: self.generation,
            });
        }
    }
}

/// The main loop owns this job as foreground maintenance before any Provider
/// stream exists. User input remains in the normal queue while it is pending.
pub(super) fn start_idle_delivery(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) {
    if !engine.has_peer_message_host()
        || app.turn_lifecycle_in_progress()
        || !ui_allows_peer_start(app)
    {
        return;
    }
    let Some(idle) = engine.try_reserve_background_work_idle() else {
        return;
    };
    let engine = engine.clone();
    let tx = tx.clone();
    let prompt = prompt.clone();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let generation = app.path_previews.next_generation();
    let handle = tokio::spawn(async move {
        let mut completion = IdleCompletion {
            tx: tx.clone(),
            transferred: false,
            generation,
        };
        let apply_cancel = stop.child_token();
        let apply_engine = engine.clone().with_cancel_token(apply_cancel.clone());
        let apply = apply_engine.apply_peer_messages_at_idle();
        tokio::pin!(apply);
        let witnesses = tokio::select! {
            biased;
            _ = stop.cancelled() => {
                apply_cancel.cancel();
                // Keep the original idle owner until its already-issued
                // storage operation reports an outcome and releases handles.
                let _ = apply.await;
                return;
            },
            result = &mut apply => match result { Ok(witnesses) => witnesses, Err(_) => return },
        };
        if witnesses.is_empty() {
            return;
        }
        if witnesses.iter().any(|witness| {
            witness.newly_inserted_into_context() || !witness.has_pending_idle_wake_admission()
        }) {
            let _ = tx.send_ordered(AppEvent::HistoryChanged).await;
        }
        let wake = tokio::select! {biased;_=stop.cancelled()=>return,result=engine.peer_idle_wake_authorized(&witnesses)=>result};
        if wake != Ok(true) {
            return;
        }
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        if !tx
            .send_ordered(AppEvent::PeerIdleReady {
                generation,
                owner: engine.state.inspection_lifecycle_identity(),
                resume_tx,
            })
            .await
        {
            return;
        }
        let allowed = tokio::select! {biased;_=stop.cancelled()=>false,result=resume_rx=>result.unwrap_or(false)};
        if !allowed || stop.is_cancelled() {
            return;
        }
        let wake = tokio::select! {biased;_=stop.cancelled()=>return,result=engine.peer_idle_wake_authorized(&witnesses)=>result};
        if wake != Ok(true) {
            return;
        }
        if engine.prepare_client_model_for_turn(None, false).is_err() {
            return;
        }
        let claim = tokio::select! {biased;_=stop.cancelled()=>return,result=engine.claim_peer_auto_wake(&witnesses)=>result};
        let permit = match claim {
            Ok(kcoder_state::PeerAutoWakeClaim::Permit(permit)) => permit,
            Ok(_) => return,
            Err(_) => {
                tracing::warn!(
                    stage = "peer_original_claim_return",
                    "Original peer claim was not handed to the turn"
                );
                return;
            }
        };
        if stop.is_cancelled() {
            return;
        }
        let engine = match engine
            .with_cancel_token(stop.clone())
            .prepare_peer_auto_wake_start(permit)
            .await
        {
            Ok(engine) => engine,
            Err(_) => {
                tracing::warn!(
                    stage = "peer_original_permit_start",
                    "Original peer permit did not reach a turn"
                );
                return;
            }
        };
        drop(idle);
        let steering = engine.begin_turn_steering();
        completion.transferred = true;
        // Reuse the exact normal turn lifecycle, Goal limits and cancellation.
        turn_execution::run_foreground_turn(
            engine, tx, prompt, stop, steering, generation, None, true,
        )
        .await;
    });
    app.foreground_operation_label = Some("Receiving session messages".into());
    app.begin_turn(handle, cancel);
    app.peer_idle_generation = Some(generation);
}

pub(super) fn finish_idle_delivery(
    app: &mut ReplApp,
    tx: &AppEventSender,
    generation: u64,
) -> HandledAppEvent {
    if app.peer_idle_generation != Some(generation) {
        return HandledAppEvent::redraw();
    }
    if let Some(handle) = app.finish_turn_state() {
        await_turn_task_for_logging(handle);
    }
    app.set_loading(false);
    // Enqueue-only delivery must not manufacture an automatic Goal wake. Only
    // a real input already queued by the user re-enters the normal scheduler.
    if !app.user_message_queue.is_empty()
        || !app.rejected_turn_steers.is_empty()
        || !app.pending_background_followups.is_empty()
    {
        let _ = tx.send(AppEvent::TurnWakeRequested);
    }
    HandledAppEvent::redraw()
}
