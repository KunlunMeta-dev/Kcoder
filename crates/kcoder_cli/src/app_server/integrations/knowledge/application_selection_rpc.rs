//! One finite public subscription source-read consent, on the original connection owner.
use super::NativeApplicationSelectionControl;
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{
    AppServerEngineFactory, ConnectionState, error_response, send, success_response,
};
use anyhow::{Result, ensure};
use kcoder_app_protocol::integrations::knowledge_host::IntegrationAutomationMethod;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_engine::QueryEngine;
use kcoder_types::integrations::core::IntegrationRequest;
use serde_json::Value;
use tokio::sync::mpsc;
pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    if method != IntegrationAutomationMethod::SelectApplicationEventSource.wire_name() {
        return Ok(false);
    }
    let prepared = (|| -> Result<_> {
        ensure!(state.knowledge_rpc_tasks.len() < 64, "KNOWLEDGE_RPC_BUSY");
        let request: IntegrationRequest = rpc_codec::decode(params.clone())?;
        let budget = std::time::Duration::from_millis(request.timeout_ms);
        let control = NativeApplicationSelectionControl::from_public_control(
            state, engine, factory, request,
        )?;
        Ok((control, budget))
    })();
    let (control, budget) = match prepared {
        Ok(value) => value,
        Err(_) => {
            send(
                outbound,
                error_response(
                    id.clone(),
                    -32073,
                    "AUTOMATION_APPLICATION_SELECTION_UNAVAILABLE",
                ),
            )
            .await?;
            return Ok(true);
        }
    };
    let (id, outbound, cancel) = (
        id.clone(),
        outbound.clone(),
        state.input_ended.child_token(),
    );
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            value = tokio::time::timeout(budget, control.run()) => value.ok(),
        };
        let response = match result.and_then(|reply| serde_json::to_value(reply).ok()) {
            Some(reply) => success_response(id, reply),
            None => error_response(id, -32073, "AUTOMATION_APPLICATION_SELECTION_UNCONFIRMED"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
