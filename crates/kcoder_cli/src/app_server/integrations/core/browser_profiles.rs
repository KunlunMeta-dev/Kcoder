//! Browser catalog RPC authorization and dispatch.
use crate::app_server::{ConnectionState, error_response, send, success_response};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::browser_profiles::BrowserProfilesMethod;
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
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    let Some(method) = BrowserProfilesMethod::parse(method) else {
        return Ok(false);
    };
    let result = (|| -> Result<Value> {
        ensure!(state.browser_profiles_v1, "BROWSER_PROFILE_UNAVAILABLE");
        let request: IntegrationRequest = rpc_codec::decode(params.clone())?;
        let native = state
            .integration_context
            .as_mut()
            .context("BROWSER_PROFILE_UNAVAILABLE")?;
        native.refresh_configuration_revision(
            engine.active_model_configuration_summary()?.revision,
        )?;
        Ok(serde_json::to_value(
            kcoder_browser::handle_profile_request(native, method, &request),
        )?)
    })();
    send(
        outbound,
        match result {
            Ok(value) => success_response(id.clone(), value),
            Err(_) => error_response(id.clone(), -32085, "BROWSER_PROFILE_UNAVAILABLE"),
        },
    )
    .await?;
    Ok(true)
}
