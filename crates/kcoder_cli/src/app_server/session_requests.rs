//! Session requests: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    workspace_engine: &QueryEngine,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
) -> Result<DispatchControl> {
    match method {
        method::SESSION_MODES => {
            let result = serde_json::from_value::<kcoder_app_protocol::SessionModesParams>(params)
                .map_err(anyhow::Error::from)
                .and_then(|params| {
                    let selected = match params.thread_id.as_deref() {
                        Some(id) => thread_manager
                            .engine(id)
                            .context("thread is not resident")?,
                        None => workspace_engine.clone(),
                    };
                    let mut result = turn_execution::inspect(&selected);
                    let thread_id = params.thread_id.unwrap_or_else(|| selected.session_id());
                    // Reported read-only so a running session can show its bound template.
                    result.settings_template =
                        recorded_settings_template_binding(&selected, &thread_id);
                    Ok(result)
                });
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::THREAD_SESSION_MODE_SET => {
            let result = async {
                let params: kcoder_app_protocol::ThreadSessionModeSetParams =
                    serde_json::from_value(params)?;
                let turn = thread_manager
                    .turn_state(&params.thread_id)
                    .context("thread is not resident")?;
                let _gate = turn.activity_gate.lock().await;
                anyhow::ensure!(
                    !turn.running.load(Ordering::SeqCst),
                    "session mode cannot change after a turn has started"
                );
                let selected = thread_manager
                    .engine(&params.thread_id)
                    .context("thread is not resident")?;
                turn_execution::set_mode(&selected, params.mode)?;
                Ok::<_, anyhow::Error>(json!({"thread":thread_snapshot(&selected, false)}))
            }
            .await;
            match result {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
