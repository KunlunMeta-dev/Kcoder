//! A peer wake executes the original target without constructing a user prompt.
use super::super::thread_runtime::PeerIdleRuntime;
use super::super::*;
use anyhow::{Result, ensure};
use kcoder_app_events::foreground_events;
use kcoder_state::peer_agent_history::PeerHistoryCommitWitness;
use sha2::{Digest, Sha256};

#[cfg(test)]
#[path = "idle_turn/pre_admission_barrier.rs"]
pub(super) mod pre_admission_barrier;

pub(in crate::app_server) struct PeerIdleTurnContext {
    pub outbound: mpsc::Sender<Value>,
    pub server_id: String,
    pub sequence: Arc<AtomicU64>,
    pub next_turn_id: Arc<AtomicU64>,
    pub cancel: CancellationToken,
    pub attended: bool,
}

/// The caller supplies the actual idle runtime, never an ID-selected surrogate.
pub(in crate::app_server) async fn start_peer_idle_turn(
    runtime: PeerIdleRuntime,
    witnesses: Vec<PeerHistoryCommitWitness>,
    context: PeerIdleTurnContext,
) -> Result<bool> {
    runtime.verify_owner()?;
    if context.cancel.is_cancelled()
        || witnesses.is_empty()
        || !witnesses
            .iter()
            .any(PeerHistoryCommitWitness::has_pending_idle_wake_admission)
    {
        return Ok(false);
    }
    ensure!(
        witnesses
            .iter()
            .all(|w| w.is_current() && w.target_state().shares_state_with(&runtime.engine.state)),
        "peer_wake_history_owner_changed"
    );
    if !runtime
        .engine
        .peer_idle_wake_authorized(&witnesses)
        .await
        .map_err(anyhow::Error::msg)?
    {
        return Ok(false);
    }
    runtime.verify_owner()?;
    if runtime.engine.turn_driver_active() || runtime.turn_state.running.load(Ordering::SeqCst) {
        return Ok(false);
    }
    {
        let mut goals = runtime
            .followups
            .goals
            .lock()
            .map_err(|_| anyhow::anyhow!("peer_goal_owner_unavailable"))?;
        if !goals.automatic_allowed(&runtime.engine)
            || runtime.engine.state.goal().is_some() && goals.is_suspended()
        {
            return Ok(false);
        }
    }
    runtime.engine.prepare_client_model_for_turn(None, false)?;
    runtime.verify_owner()?;
    let thread = runtime.engine.session_id();
    let turn = format!(
        "peer-{}-{}",
        context.next_turn_id.fetch_add(1, Ordering::SeqCst),
        uuid::Uuid::new_v4()
    );
    let attempt = kcoder_types::TurnAttemptIdentity {
        thread_id: thread.clone(),
        turn_id: turn.clone(),
        attempt_id: uuid::Uuid::new_v4().to_string(),
    };
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "kcoder.peer-wake.v1",
            &thread,
            witnesses
                .iter()
                .map(PeerHistoryCommitWitness::history_uuid)
                .collect::<Vec<_>>()
        ))?)
    );
    let input_hash = turn_artifacts::input_context_hash(&runtime.engine.state.messages())?;
    #[cfg(test)]
    pre_admission_barrier::checkpoint(&thread).await;
    let wake = runtime.engine.peer_idle_wake_authorized(&witnesses).await;
    if wake != Ok(true) || context.cancel.is_cancelled() {
        return wake.map(|_| false).map_err(anyhow::Error::msg);
    }
    runtime.verify_owner()?;
    if runtime
        .turn_state
        .pending_user_admissions
        .load(Ordering::SeqCst)
        != 0
        || !runtime.turn_state.try_claim_turn()
    {
        return Ok(false);
    }
    let cancel = context.cancel.child_token();
    let mut transition = PeerStartTransition {
        state: runtime.turn_state.clone(),
        followups: runtime.followups.clone(),
        engine: runtime.engine.clone(),
        attempt: attempt.clone(),
        cancel: cancel.clone(),
        goal: None,
        accepted: false,
        settled: false,
        transferred: false,
    };
    // The actual registration gate orders this reservation against real user input.
    if runtime
        .turn_state
        .pending_user_admissions
        .load(Ordering::SeqCst)
        != 0
        || context.cancel.is_cancelled()
    {
        return Ok(false);
    }
    runtime.verify_owner()?;
    let permit = match runtime.engine.claim_peer_auto_wake(&witnesses).await {
        Ok(kcoder_state::PeerAutoWakeClaim::Permit(permit)) => permit,
        Ok(_) => return Ok(false),
        Err(code) => return Err(anyhow::Error::msg(code)),
    };
    if context.cancel.is_cancelled() || runtime.verify_owner().is_err() {
        return Ok(false);
    }
    let engine = runtime
        .engine
        .clone()
        .with_cancel_token(cancel.clone())
        .prepare_peer_auto_wake_start(permit)
        .await
        .map_err(anyhow::Error::msg)?;
    if context.cancel.is_cancelled() || runtime.verify_owner().is_err() {
        return Ok(false);
    }
    let history = engine.state.history_attempt_scope(attempt.clone())?;
    transition.engine = engine.clone();
    // No Native attempt exists before actual admission. An uncertain begin is
    // never rolled back or retried, and the original consumed permit stays spent.
    turn_attempts::begin(&engine, &attempt, false, None, input_hash, fingerprint)?;
    transition.accepted = true;
    if let Err(error) = turn_attempts::save_model_snapshot(&engine, &attempt) {
        transition.settle("failed", "peer model snapshot unavailable");
        return Err(error);
    }
    if context.cancel.is_cancelled() || runtime.verify_owner().is_err() {
        return Ok(false);
    }
    let state = runtime.turn_state.clone();
    let followups = runtime.followups.clone();
    let goal_turn = followups
        .goals
        .lock()
        .map_err(|_| anyhow::anyhow!("peer_goal_owner_unavailable"))?
        .begin(&engine, None, Some(cancel.clone()));
    transition.goal = Some(goal_turn);
    let projection = Arc::new(Mutex::new(StreamProjection::new(
        context.server_id.clone(),
        thread.clone(),
        turn.clone(),
        context.sequence.clone(),
    )));
    projection.lock().await.item_namespace = attempt.attempt_id.clone();
    runtime.verify_owner()?;
    set_active_background_projection(
        &runtime.background_projection,
        &thread,
        &turn,
        projection.clone(),
    )
    .await;
    runtime.verify_owner()?;
    *state
        .question_context
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(QuestionContext {
        server_id: context.server_id.clone(),
        thread_id: thread.clone(),
        turn_id: turn.clone(),
    });
    *state
        .approval_context
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(ApprovalContext {
        server_id: context.server_id.clone(),
        thread_id: thread.clone(),
        turn_id: turn.clone(),
    });
    let (mut permission, questioner) = state.interactions_for_input(context.outbound.clone(), None);
    let goal_turn = transition.goal.take().context("peer_goal_turn_required")?;
    if let Some(mode) = goal_turn.permission_mode {
        permission.mode = mode;
    }
    let questioner: Arc<dyn kcoder_tools::UserQuestioner> = if context.attended {
        questioner
    } else {
        if permission.mode != kcoder_config::PermissionMode::Bypass {
            permission.mode = kcoder_config::PermissionMode::DontAsk;
        }
        Arc::new(kcoder_tools::DenyAllUserQuestioner)
    };
    let mut engine = engine;
    engine.set_user_questioner(questioner);
    let task_cancel = cancel.clone();
    let task_attempt = attempt.clone();
    let task_thread = thread.clone();
    let task_turn = turn.clone();
    let task_state = state.clone();
    let active_owner = followups
        .continuation_client_lifetime()
        .as_ref()
        .map(input_lifetime::ClientInputLifetime::owner);
    let background = runtime.background_projection.clone();
    let (start, ready) = tokio::sync::oneshot::channel();
    let handle=tokio::spawn(history.run(async move {
        let permission_mode=goal_turn.permission_mode;
        let mut cleanup=PeerTurnCleanup {engine:engine.clone(),goal:Some(goal_turn),state:task_state.clone(),followups:followups.clone(),cancel:task_cancel.clone(),thread:task_thread.clone(),turn:task_turn.clone(),finished:false};
        if ready.await.is_err() {return;}
        let _permissions=turn_permissions::TurnPermissions::new(engine.clone(),permission_mode);
        let mut partial=turn_attempts::PartialOutput::default();let mut status="completed";let mut error=None;let mut provider_failure=None;
        let native=engine.observe_native_turn_acceptance(&task_attempt).await;
        if native.is_err() {status="failed";error=Some("peer_native_attempt_unavailable".to_owned());}
        if send(&context.outbound,notification("turn/started",with_event_context(&context.server_id,&task_thread,Some(&task_turn),&context.sequence,json!({"attemptId":task_attempt.attempt_id,"turn":{"id":task_turn,"threadId":task_thread,"status":"running","internal":true}})))).await.is_err() {task_cancel.cancel();}
        if status=="completed" && !task_cancel.is_cancelled() {
            let steering=engine.begin_turn_steering();
            let mut stream=if let Some(steering)=steering {engine.run_peer_message_turn_stream_with_cancel_and_steering(&permission,task_cancel.clone(),steering)}else{engine.run_peer_message_turn_stream(&permission)};
            while let Some(event)=stream.next().await {
                let event=normalize_cancelled_terminal_event(event,task_cancel.is_cancelled());
                let _interaction=foreground_events::publish_interaction_updates(&engine,&task_state,&context.outbound,&task_thread,&task_turn,&event,&task_cancel).await;
                partial.observe(&event);
                task_state.observe_live_assistant(&task_attempt,&event);
                if let Some((outcome,reason))=terminal_outcome(&event,task_cancel.is_cancelled()) {status=outcome;error=Some(reason);}
                if let EngineEvent::ProviderFailed {details,..}=&event {provider_failure=Some(details.clone());}
                if let EngineEvent::ToolUseStarted {id,name,..}=&event && tool_can_spawn_managed_background_job(name) {register_background_tool_call(&background,id,&task_thread,&task_turn,projection.clone()).await;}
                let messages=if background_event_id(&event).is_some() {let _=project_managed_background_event(&engine,&background,&context.outbound,event).await;Vec::new()}else{projection.lock().await.project(event)};
                for frame in messages {if send(&context.outbound,frame).await.is_err() {task_cancel.cancel();break;}}
                if status!="completed" || task_cancel.is_cancelled() {break;}
            }
        }
        if task_cancel.is_cancelled() {status="interrupted";error=Some("cancelled by owner".into());provider_failure=None;}
        let residual=engine.close_active_turn_steering();for frame in foreground_events::dropped_notifications(&task_state,&residual) {let _=send(&context.outbound,frame).await;}
        let _=engine.state.flush_history().await;
        let _=save_turn_outcome(&engine,&task_thread,&task_turn,status,error.as_deref(),provider_failure.as_ref());
        let _=turn_attempts::finish(&engine,&task_attempt,status,error.as_deref(),provider_failure.as_ref(),&partial);
        if let Some(goal)=cleanup.goal.take() {followups.goals.lock().unwrap_or_else(|p|p.into_inner()).finish(&engine,goal,status,provider_failure.as_ref());}
        if engine.state.goal().is_some() {goal_lifecycle::publish(&engine,&context.outbound).await;}
        task_state.clear_matching_turn(&task_thread,&task_turn);projection.lock().await.turn_terminal=true;
        clear_active_background_projection(&background,&task_thread,&task_turn).await;
        let _=task_state.publish_turn_completion(&context.outbound,notification("turn/completed",with_event_context(&context.server_id,&task_thread,Some(&task_turn),&context.sequence,json!({"attemptId":task_attempt.attempt_id,"turn":{"id":task_turn,"threadId":task_thread,"status":status,"internal":true},"error":turn_completion_error(error,provider_failure)})))).await;
        cleanup.finished=true;followups.notify.notify_waiters();
    }));
    let mut active = state.active_turn.lock().await;
    runtime.verify_owner()?;
    *active = Some(ActiveTurn {
        desktop_owner: None,
        input_owner: active_owner,
        handle,
        cancel,
        thread_id: thread,
        turn_id: turn,
        attempt: Some(attempt),
        origin: request_origin::RequestOrigin::PeerAgent,
    });
    drop(active);
    transition.transferred = true;
    // Release the actual target registration only after publishing its active handle.
    drop(runtime);
    let _ = start.send(());
    Ok(true)
}
struct PeerStartTransition {
    state: ResidentTurnState,
    followups: Arc<BackgroundFollowupState>,
    engine: QueryEngine,
    attempt: kcoder_types::TurnAttemptIdentity,
    cancel: CancellationToken,
    goal: Option<goal_lifecycle::GoalTurn>,
    accepted: bool,
    settled: bool,
    transferred: bool,
}
impl PeerStartTransition {
    fn settle(&mut self, status: &str, reason: &str) {
        if !self.accepted || self.settled {
            return;
        }
        // Mark before the write: an unknown receipt must not trigger a second finish.
        self.settled = true;
        let _ = turn_attempts::finish(
            &self.engine,
            &self.attempt,
            status,
            Some(reason),
            None,
            &turn_attempts::PartialOutput::default(),
        );
    }
}
impl Drop for PeerStartTransition {
    fn drop(&mut self) {
        if !self.transferred {
            self.cancel.cancel();
            self.state
                .clear_matching_turn(&self.attempt.thread_id, &self.attempt.turn_id);
            self.settle("interrupted", "peer turn was not dispatched");
            if let Some(goal) = self.goal.take() {
                self.followups
                    .goals
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .finish(&self.engine, goal, "interrupted", None);
            }
            self.state.running.store(false, Ordering::SeqCst);
            self.followups.notify.notify_waiters();
        }
    }
}
struct PeerTurnCleanup {
    engine: QueryEngine,
    goal: Option<goal_lifecycle::GoalTurn>,
    state: ResidentTurnState,
    followups: Arc<BackgroundFollowupState>,
    cancel: CancellationToken,
    thread: String,
    turn: String,
    finished: bool,
}
impl Drop for PeerTurnCleanup {
    fn drop(&mut self) {
        if !self.finished {
            self.cancel.cancel();
            if let Some(goal) = self.goal.take() {
                self.followups
                    .goals
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .finish(&self.engine, goal, "interrupted", None);
            }
            self.state.clear_matching_turn(&self.thread, &self.turn);
            // A pre-publication task can finish after its registration was
            // retired. Never clear a newer turn's shared running latch.
            if self
                .state
                .active_turn
                .try_lock()
                .ok()
                .is_some_and(|active| {
                    active.as_ref().is_some_and(|active| {
                        active.thread_id == self.thread && active.turn_id == self.turn
                    })
                })
            {
                self.state.running.store(false, Ordering::SeqCst);
            }
            self.followups.notify.notify_waiters();
        }
    }
}
