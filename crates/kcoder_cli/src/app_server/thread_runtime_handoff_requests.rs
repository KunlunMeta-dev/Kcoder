//! Only the actual UI owner can release its idle original resident task.
use super::*;
use kcoder_app_protocol::{
    METHOD_THREAD_RUNTIME_HANDOFF_READ, ThreadRuntimeHandoffReadParams,
    ThreadRuntimeHandoffReleaseParams, ThreadRuntimeHandoffReleaseResult,
};
use thread_runtime::HandoffBegin;

#[expect(
    clippy::too_many_arguments,
    reason = "Keep the original connection, runtime and response owners explicit"
)]
pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    engines: (&mut QueryEngine, &QueryEngine),
    outbound: &mpsc::Sender<Value>,
    manager: &mut ThreadManager,
    server: &str,
    state: &mut ConnectionState,
) -> Result<DispatchControl> {
    let result: Result<Value> = async {
        ensure!(
            state.thread_runtime_handoff_v1,
            "THREAD_HANDOFF_NEGOTIATION_REQUIRED"
        );
        ensure!(
            state.initialized
                && !state.native_source_dispatch
                && state.native_source_accepted.is_none(),
            "THREAD_HANDOFF_ORIGINAL_UI_REQUIRED"
        );
        if method == METHOD_THREAD_RUNTIME_HANDOFF_READ {
            let p: ThreadRuntimeHandoffReadParams = serde_json::from_value(params)?;
            return Ok(serde_json::to_value(manager.handoff_read(&p, server)?)?);
        }
        let p: ThreadRuntimeHandoffReleaseParams = serde_json::from_value(params)?;
        ensure!(p.is_valid(), "THREAD_HANDOFF_REQUEST_INVALID");
        let _lifecycle =
            thread_metadata::try_acquire_thread_lifecycle_locks(engines.1, &[&p.thread_id])?;
        let result = manager.begin_handoff(&p, server, state.mcp_app_tasks.is_empty())?;
        let receipt = match result {
            HandoffBegin::Reply(receipt) => receipt,
            HandoffBegin::Reserved(reserved) => {
                if manager.flush_handoff(&p).await.is_err() {
                    drop(reserved);
                    manager.abort_handoff(&p, "THREAD_HANDOFF_HISTORY_UNAVAILABLE")?
                } else if mcp_apps_rpc::revoke_thread(state, Some(&p.thread_id))
                    .await
                    .is_err()
                {
                    // Keep the original Engine and exclusive lease, reopening its
                    // admissions if owned UI resources could not be revoked.
                    drop(reserved);
                    manager.abort_handoff(&p, "THREAD_HANDOFF_REVOKE_FAILED")?
                } else {
                    let runtime = manager.commit_handoff(&p, reserved)?;
                    if engines.0.session_id() == p.thread_id {
                        *engines.0 = engines.1.clone();
                    }
                    runtime.shutdown().await;
                    state.agent_streams.unsubscribe_thread(&p.thread_id);
                    state.mcp_app_registry.forget(&p.thread_id);
                    manager.finish_handoff(&p)?
                }
            }
        };
        Ok(serde_json::to_value(ThreadRuntimeHandoffReleaseResult {
            snapshot: manager.handoff_snapshot(&p.thread_id, server),
            receipt,
        })?)
    }
    .await;
    let response = match result {
        Ok(value) => success_response(id, value),
        Err(error) => {
            // No private history/configuration path is copied into RPC errors.
            let code = error.to_string();
            let public = if code.starts_with("THREAD_HANDOFF_") {
                code.as_str()
            } else {
                "THREAD_HANDOFF_REQUEST_UNAVAILABLE"
            };
            error_response(id, -32087, public)
        }
    };
    send(outbound, response).await?;
    Ok(DispatchControl::Continue)
}
