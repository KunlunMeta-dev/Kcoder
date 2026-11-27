//! A live, negotiated resume boundary; persisted history is never a live turn identity.
use super::*;
use kcoder_app_protocol::{ThreadStreamContextV1, ThreadStreamTurnV1, TurnStatus};

pub(super) async fn snapshot(
    manager: &ThreadManager,
    thread: &str,
    server: &str,
    sequence: &Arc<AtomicU64>,
) -> Option<ThreadStreamContextV1> {
    let state = manager.turn_state(thread)?;
    // Registration and forced cancellation own this gate. Ordinary progress and
    // terminal decisions serialize on the active projection's mutex below.
    let _registration = state.activity_gate.lock().await;
    let active_turn = if state.running.load(Ordering::SeqCst) {
        let projections = manager.projection(thread)?;
        let guard = projections.lock().await;
        let active = guard.active.as_ref()?;
        let projection = active.projection.lock().await;
        if projection.server_id != server || projection.thread_id != thread {
            return None;
        }
        let active_turn = (!projection.turn_terminal).then(|| ThreadStreamTurnV1 {
            id: projection.turn_id.clone(),
            attempt_id: projection.item_namespace.clone(),
            thread_id: thread.to_owned(),
            status: TurnStatus::Running,
        });
        return Some(ThreadStreamContextV1 {
            server_id: server.to_owned(),
            through_sequence: sequence.load(Ordering::SeqCst).saturating_sub(1),
            active_turn: active_turn.into(),
        });
    } else {
        None
    };
    Some(ThreadStreamContextV1 {
        server_id: server.to_owned(),
        through_sequence: sequence.load(Ordering::SeqCst).saturating_sub(1),
        active_turn: active_turn.into(),
    })
}

pub(super) async fn attach(
    response: &mut Value,
    state: &ConnectionState,
    manager: &ThreadManager,
    thread: &str,
    server: &str,
    sequence: &Arc<AtomicU64>,
) {
    if state.stream_context_v1
        && response.get("result").is_some()
        && let Some(context) = snapshot(manager, thread, server, sequence).await
    {
        response["result"]["streamContext"] = json!(context);
        enforce_budget(response, OUTBOUND_FRAME_LIMIT_BYTES);
    }
}

fn enforce_budget(response: &mut Value, limit: usize) {
    if serde_json::to_vec(response).is_ok_and(|bytes| bytes.len() > limit) {
        response["result"]
            .as_object_mut()
            .unwrap()
            .remove("history");
        if serde_json::to_vec(response).is_ok_and(|bytes| bytes.len() > limit) {
            // Unknown is safer than truncating either identity or existing Thread metadata.
            response["result"]
                .as_object_mut()
                .unwrap()
                .remove("streamContext");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_drops_inline_history_before_the_authoritative_boundary() {
        let context = json!({"serverId":"instance","throughSequence":7,"activeTurn":null});
        let mut response = success_response(
            json!(1),
            json!({"thread":{"id":"thread"},"streamContext":context,"history":{"page":"x".repeat(4096)}}),
        );
        let expected = success_response(
            json!(1),
            json!({"thread":{"id":"thread"},"streamContext":context}),
        );
        enforce_budget(&mut response, serde_json::to_vec(&expected).unwrap().len());
        assert_eq!(response, expected);
        let legacy = success_response(json!(1), json!({"thread":{"id":"thread"}}));
        enforce_budget(&mut response, serde_json::to_vec(&legacy).unwrap().len());
        assert_eq!(response, legacy);
    }
}
