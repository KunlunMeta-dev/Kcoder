//! Typed residency facts for clients that negotiated `threadResidencyV1`.
//!
//! An idle runtime evicted for capacity is still a persisted thread of this
//! workspace. Thread-scoped requests that need its live runtime are answered
//! with `THREAD_NOT_RESIDENT` before any admission, write or side effect, so
//! the client can `thread/resume` and retry only what is safe to retry. Reads
//! served from persisted state (for example `thread/read` or an expert read)
//! are not gated and keep working without residency.

use super::*;
use kcoder_app_protocol::{
    ThreadEvictedParams, ThreadEvictionReason, ThreadNotResidentErrorDataV1,
};

/// The thread a request needs a live runtime for, if it does.
fn resident_thread<'a>(method: &str, params: &'a Value) -> Option<&'a str> {
    let thread = || params.get("threadId").and_then(Value::as_str);
    match method {
        // Ratings need the original Engine's project scope and child registry.
        kcoder_app_protocol::evolution::method::RATE
        | kcoder_app_protocol::evolution::method::RATINGS_LIST => thread(),
        method::TURN_START
        | method::TURN_STEER
        | method::COMPUTER_USE_RECOVER
        | method::THREAD_COMPACT
        | method::THREAD_ROLLBACK
        | method::THREAD_GOAL_SET
        | method::THREAD_GOAL_CLEAR
        | method::THREAD_SESSION_MODE_SET
        | method::THREAD_MODEL_SELECT
        | method::THREAD_AUTOMATION_SUSPEND
        | method::SESSION_MODES
        | method::TOOLS_CATALOG
        | method::AGENT_LIST
        | method::AGENT_ARTIFACT_READ
        | method::AGENT_STEER
        | method::AGENT_CONTINUE
        | method::AGENT_STOP
        | method::AGENT_LIVE_READ
        | method::AGENT_STREAM_SUBSCRIBE
        | method::ATTACHMENT_READ
        | method::ATTACHMENT_READ_CHUNK
        | kcoder_app_protocol::METHOD_THREAD_LIFETIME_READ
        | kcoder_app_protocol::METHOD_THREAD_LIFETIME_SET => thread(),
        // An expert read is served from the persisted sidecar; only a change
        // needs the resident owner.
        kcoder_app_protocol::METHOD_THREAD_EXPERT
            if params.get("change").is_some_and(|change| !change.is_null()) =>
        {
            thread()
        }
        _ => None,
    }
}

/// Answer a request for an evicted thread with the typed rejection. Returns
/// `true` when the request was answered and must not be dispatched.
pub(super) async fn reject_evicted(
    method: &str,
    id: &Value,
    params: &Value,
    thread_manager: &ThreadManager,
    state: &ConnectionState,
    outbound_tx: &mpsc::Sender<Value>,
) -> Result<bool> {
    if !state.thread_residency_v1 {
        return Ok(false);
    }
    let Some(thread_id) = resident_thread(method, params) else {
        return Ok(false);
    };
    if !thread_manager.was_evicted(thread_id) {
        return Ok(false);
    }
    send(outbound_tx, not_resident_response(id.clone(), thread_id)).await?;
    Ok(true)
}

/// An expert change writes the same session sidecar a running compaction or
/// rollback commits; it is rejected before mutation and may be retried.
pub(super) async fn reject_during_maintenance(
    method: &str,
    id: &Value,
    params: &Value,
    thread_manager: &ThreadManager,
    state: &ConnectionState,
    outbound_tx: &mpsc::Sender<Value>,
) -> Result<bool> {
    if method != kcoder_app_protocol::METHOD_THREAD_EXPERT {
        return Ok(false);
    }
    let Some(thread_id) = resident_thread(method, params) else {
        return Ok(false);
    };
    let Some(running) = thread_manager
        .turn_state(thread_id)
        .and_then(|turn| turn.maintenance_operation())
    else {
        return Ok(false);
    };
    send(
        outbound_tx,
        thread_rewind_requests::maintenance_busy_response(
            id.clone(),
            thread_id,
            running,
            -32087,
            state.thread_maintenance_v1,
        ),
    )
    .await?;
    Ok(true)
}

fn not_resident_response(id: Value, thread_id: &str) -> Value {
    let mut response = error_response(
        id,
        kcoder_app_protocol::THREAD_NOT_RESIDENT,
        "thread is not resident; thread/resume it and retry",
    );
    if let Ok(data) = serde_json::to_value(ThreadNotResidentErrorDataV1 {
        thread_id: thread_id.to_owned(),
        reason: ThreadEvictionReason::Capacity,
    }) {
        response["error"]["data"] = data;
    }
    response
}

/// Announce evictions once. Connections without the capability only drop them.
pub(super) async fn publish_evictions(
    thread_manager: &mut ThreadManager,
    state: &ConnectionState,
    outbound_tx: &mpsc::Sender<Value>,
) -> Result<()> {
    let evicted = thread_manager.take_eviction_notices();
    if !state.thread_residency_v1 {
        return Ok(());
    }
    for thread_id in evicted {
        let params = serde_json::to_value(ThreadEvictedParams {
            thread_id,
            reason: ThreadEvictionReason::Capacity,
        })?;
        send(
            outbound_tx,
            notification(kcoder_app_protocol::METHOD_THREAD_EVICTED, params),
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::resident_thread;
    use serde_json::json;

    #[test]
    fn only_runtime_scoped_requests_are_gated() {
        let params = json!({"threadId":"t-1"});
        assert_eq!(resident_thread("turn/start", &params), Some("t-1"));
        assert_eq!(resident_thread("thread/compact", &params), Some("t-1"));
        assert_eq!(resident_thread("evolution/rate", &params), Some("t-1"));
        assert_eq!(
            resident_thread("evolution/ratings/list", &params),
            Some("t-1")
        );
        // Persisted reads and resume itself are never gated.
        assert_eq!(resident_thread("thread/read", &params), None);
        assert_eq!(resident_thread("thread/resume", &params), None);
        assert_eq!(resident_thread("thread/expert", &params), None);
        assert_eq!(
            resident_thread(
                "thread/expert",
                &json!({"threadId":"t-1","change":{"expectedRevision":0,"expert":null}})
            ),
            Some("t-1")
        );
    }
}
