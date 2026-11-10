//! `turn/steer`: add user input to the running main-thread turn.
//!
//! The Engine steering mailbox owns ordering: a steer enters history only after
//! the current provider response and its complete tool batch. This module only
//! admits the input and later settles each accepted steer exactly once, as
//! `turn/steer/applied` or `turn/steer/dropped`.
use super::*;
use kcoder_app_events::resident_turn::PendingUserSteer;
use kcoder_app_protocol::{TurnSteerParams, TurnSteerResult, TurnSteerStatus};

pub(super) async fn dispatch(
    id: Value,
    params: Value,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &ThreadManager,
    next_interaction_id: &AtomicU64,
) -> Result<DispatchControl> {
    let params = match kcoder_app_rpc_codec::decode::<TurnSteerParams>(params) {
        Ok(params) => params,
        Err(error) => {
            send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
            return Ok(DispatchControl::Continue);
        }
    };
    if let Err(error) = params.validate() {
        send(outbound_tx, error_response(id, -32602, error)).await?;
        return Ok(DispatchControl::Continue);
    }
    let reply = |status, turn_id: Option<String>, steer_id| {
        success_response(
            id.clone(),
            kcoder_app_rpc_codec::encode(TurnSteerResult {
                status,
                turn_id,
                steer_id,
            })
            .unwrap_or(Value::Null),
        )
    };
    let (Some(turn_state), Some(engine)) = (
        thread_manager.turn_state(&params.thread_id),
        thread_manager.engine(&params.thread_id),
    ) else {
        send(
            outbound_tx,
            reply(TurnSteerStatus::NoActiveTurn, None, None),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    };
    let active_turn_id = turn_state
        .active_turn
        .lock()
        .await
        .as_ref()
        .filter(|active| active.thread_id == params.thread_id)
        .map(|active| active.turn_id.clone());
    let Some(turn_id) = active_turn_id.filter(|turn_id| {
        turn_state.running.load(Ordering::SeqCst)
            && params
                .turn_id
                .as_ref()
                .is_none_or(|wanted| wanted == turn_id)
    }) else {
        send(
            outbound_tx,
            reply(TurnSteerStatus::NoActiveTurn, None, None),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    };
    let Some(owner) = engine.state.try_inspection_lifecycle_identity() else {
        send(
            outbound_tx,
            reply(TurnSteerStatus::Busy, Some(turn_id), None),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    };
    let Some(steer_id) = next_interaction_id
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            current.checked_add(1)
        })
        .ok()
    else {
        send(
            outbound_tx,
            reply(TurnSteerStatus::Busy, Some(turn_id), None),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    };
    // Hold event projection until this response is queued, so the applied
    // notification can never overtake the receipt that names its steer id.
    let _response_order = Arc::clone(&turn_state.async_question_response_gate)
        .lock_owned()
        .await;
    // Register before enqueueing: the turn may apply the steer immediately.
    turn_state
        .user_steers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            steer_id,
            PendingUserSteer {
                thread_id: params.thread_id.clone(),
                turn_id: turn_id.clone(),
                client_message_id: params.client_message_id.clone(),
                text: params.text.clone(),
            },
        );
    let status = match engine.try_enqueue_turn_steer_for_lifecycle(
        &owner,
        steer_id,
        kcoder_types::Message::user_text(params.text),
    ) {
        kcoder_engine::GuardedTurnSteer::Queued => TurnSteerStatus::Queued,
        kcoder_engine::GuardedTurnSteer::NoActiveTurn
        | kcoder_engine::GuardedTurnSteer::OwnerChanged => TurnSteerStatus::NoActiveTurn,
        kcoder_engine::GuardedTurnSteer::Busy => TurnSteerStatus::Busy,
        kcoder_engine::GuardedTurnSteer::QueueFull { .. } => TurnSteerStatus::QueueFull,
    };
    if status != TurnSteerStatus::Queued {
        turn_state
            .user_steers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&steer_id);
    }
    let steer_id = (status == TurnSteerStatus::Queued).then_some(steer_id);
    send(outbound_tx, reply(status, Some(turn_id), steer_id)).await?;
    Ok(DispatchControl::Continue)
}
