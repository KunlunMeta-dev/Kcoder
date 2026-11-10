//! Foreground event fan-out and response ordering for a resident turn.
use crate::background_delivery::{
    TerminalResultObserver, project_managed_background_event, register_background_tool_call,
};
use crate::notification_projection::{
    background_event_id, terminal_outcome, tool_can_spawn_managed_background_job,
};
use crate::resident_turn::ResidentTurnState;
use crate::{BackgroundProjectionState, StreamProjection};
use anyhow::Result;
use kcoder_app_interactions::async_questions::{publish_changed, publish_changed_by_id};
use kcoder_engine::{EngineEvent, QueryEngine};
use kcoder_host_transport::protocol_io::send;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedMutexGuard, mpsc};
use tokio_util::sync::CancellationToken;

pub async fn publish_interaction_updates(
    engine: &QueryEngine,
    turn_state: &ResidentTurnState,
    outbound: &mpsc::Sender<Value>,
    thread_id: &str,
    turn_id: &str,
    event: &EngineEvent,
    cancel: &CancellationToken,
) -> OwnedMutexGuard<()> {
    let mut dropped_user_steers = Vec::new();
    let terminal_questions = if terminal_outcome(event, cancel.is_cancelled()).is_some() {
        // Close Engine admission before awaiting the response-order gate or
        // projecting the terminal event. A concurrent answer can otherwise be
        // accepted into a steering session that this loop is about to drop.
        let undrained = engine.close_active_turn_steering();
        dropped_user_steers = dropped_notifications(turn_state, &undrained);
        let owner = engine.state.inspection_lifecycle_identity();
        for receipt_id in undrained {
            let question_id = turn_state
                .async_question_steers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&receipt_id);
            let Some(question_id) = question_id else {
                continue;
            };
            if let Ok(Some(claim)) = engine
                .state
                .get_async_question_delivery_claim(&owner, &question_id)
            {
                // The Engine returned this ID from its still-pending mailbox,
                // proving no identified history commit began for this delivery.
                let _ = engine.state.mark_async_question_delivery_failed(
                    &owner,
                    &claim,
                    "source turn ended before the saved answer entered history",
                );
            }
        }
        engine
            .state
            .mark_async_questions_stale_for_turn(&owner, turn_id)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let response_order = Arc::clone(&turn_state.async_question_response_gate)
        .lock_owned()
        .await;
    for question in terminal_questions {
        publish_changed(outbound, &question).await;
    }
    // Settle user steers the ended turn never applied, so the client can
    // resend the text instead of believing it was delivered.
    for dropped in std::mem::take(&mut dropped_user_steers) {
        let _ = send(outbound, dropped).await;
    }
    if let EngineEvent::TurnSteerApplied { id } = event
        && let Some(applied) = applied_notification(turn_state, *id)
    {
        let _ = send(outbound, applied).await;
    }
    let applied_async_question = match event {
        EngineEvent::TurnSteerApplied { id } => turn_state
            .async_question_steers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id),
        _ => None,
    };
    if let Some(question_id) = applied_async_question {
        publish_changed_by_id(&engine.state, outbound, thread_id, &question_id).await;
    }

    // The caller retains the gate through the rest of this event's projection.
    response_order
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep the original projection owners and terminal recorder explicit"
)]
pub async fn project(
    engine: &QueryEngine,
    background_projection: &Arc<Mutex<BackgroundProjectionState>>,
    projection: &Arc<Mutex<StreamProjection>>,
    outbound: &mpsc::Sender<Value>,
    thread_id: &str,
    turn_id: &str,
    event: EngineEvent,
    record_terminal_result: TerminalResultObserver,
) -> Result<()> {
    if let EngineEvent::ToolUseStarted { id, name, .. } = &event
        && tool_can_spawn_managed_background_job(name)
    {
        register_background_tool_call(
            background_projection,
            id,
            thread_id,
            turn_id,
            Arc::clone(projection),
        )
        .await;
    }

    // The connection pump owns background lifecycle delivery. Foreground
    // projection would duplicate events surfaced for conversation injection.
    if background_event_id(&event).is_some() {
        return project_managed_background_event(
            engine,
            background_projection,
            outbound,
            event,
            record_terminal_result,
        )
        .await;
    }
    let messages = projection.lock().await.project(event);
    for message in messages {
        send(outbound, message).await?;
    }
    Ok(())
}

/// Notification for a steer the turn just applied, if it was a user steer.
fn applied_notification(turn_state: &ResidentTurnState, steer_id: u64) -> Option<Value> {
    turn_state
        .user_steers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&steer_id)
        .map(|steer| steer.settled(steer_id, false))
}

/// Notifications for user steers the ending turn never applied. `undrained`
/// comes from the Engine mailbox, so none of these entered history.
pub fn dropped_notifications(turn_state: &ResidentTurnState, undrained: &[u64]) -> Vec<Value> {
    let mut steers = turn_state
        .user_steers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    undrained
        .iter()
        .filter_map(|steer_id| {
            steers
                .remove(steer_id)
                .map(|steer| steer.settled(*steer_id, true))
        })
        .collect()
}
