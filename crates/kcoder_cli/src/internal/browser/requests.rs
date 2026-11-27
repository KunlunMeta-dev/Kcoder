//! Browser RPC execution with the host's current session and native scope.

use crate::BrowserRegistry;
use anyhow::{Context, Result};
use kcoder_app_protocol::{
    BrowserActionParams, BrowserEvaluateParams, BrowserSessionParams, BrowserStartParams, method,
};
use kcoder_host_transport::protocol_io::{
    MAX_DEVICE_RESULT_BYTES, browser_success_response, error_response, send, success_response,
};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_state::AppState;
use serde_json::Value;
use tokio::sync::mpsc;

#[expect(
    clippy::too_many_arguments,
    reason = "Keep separately borrowed session, native scope and browser owners explicit"
)]
pub async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    session: &AppState,
    current_configuration_revision: &(dyn Fn() -> Result<String> + Sync),
    outbound_tx: &mpsc::Sender<Value>,
    browsers: &mut BrowserRegistry,
    profile_context: Option<&mut NativeIntegrationContext>,
) -> Result<()> {
    match method {
        kcoder_app_protocol::browser_profiles::BROWSER_PROFILE_CONTROL_READ => {
            let result = async {
                anyhow::ensure!(
                    profile_context.is_some(),
                    "BROWSER_PROFILE_SESSION_UNAVAILABLE"
                );
                let input: kcoder_app_protocol::browser_profiles::BrowserControlReadParams =
                    serde_json::from_value(params)?;
                browsers
                    .control_read(BrowserSessionParams {
                        session_id: input.session_id,
                    })
                    .await
            }
            .await;
            send(
                outbound_tx,
                match result {
                    Ok(value) => success_response(id, serde_json::to_value(value)?),
                    Err(error) => error_response(id, -32085, &error.to_string()),
                },
            )
            .await?;
        }
        kcoder_app_protocol::browser_profiles::BROWSER_PROFILE_HANDOFF => {
            let result = async {
                anyhow::ensure!(
                    profile_context.is_some(),
                    "BROWSER_PROFILE_SESSION_UNAVAILABLE"
                );
                let params = serde_json::from_value(params)?;
                browsers.handoff(params).await
            }
            .await;
            send(
                outbound_tx,
                match result {
                    Ok(value) => success_response(id, serde_json::to_value(value)?),
                    Err(error) => error_response(id, -32085, &error.to_string()),
                },
            )
            .await?;
        }
        kcoder_app_protocol::browser_profiles::BROWSER_PROFILE_HUMAN_ACTION => {
            let result = async {
                anyhow::ensure!(
                    profile_context.is_some(),
                    "BROWSER_PROFILE_SESSION_UNAVAILABLE"
                );
                let params = serde_json::from_value(params)?;
                browsers.human_action(params).await
            }
            .await;
            send(
                outbound_tx,
                match result {
                    Ok(value) => success_response(id, serde_json::to_value(value)?),
                    Err(error) => error_response(id, -32085, &error.to_string()),
                },
            )
            .await?;
        }
        method::BROWSER_PREFLIGHT => {
            if !params.as_object().is_some_and(|object| object.is_empty()) {
                send(
                    outbound_tx,
                    error_response(id, -32602, "browser/preflight does not accept parameters"),
                )
                .await?;
            } else {
                send(
                    outbound_tx,
                    success_response(id, serde_json::to_value(crate::browser_preflight_result())?),
                )
                .await?;
            }
        }
        method::BROWSER_START => {
            let result = match kcoder_app_rpc_codec::decode::<BrowserStartParams>(params) {
                Ok(params) => {
                    let prepared = (|| -> Result<_> {
                        if let Some(context) = profile_context {
                            context
                                .refresh_configuration_revision(current_configuration_revision()?)?;
                            Ok(Some(&*context))
                        } else {
                            Ok(None)
                        }
                    })();
                    match prepared {
                        Ok(context) => browsers.start(&session.session_id(), params, context).await,
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error).context("invalid browser/start params"),
            };
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        browser_success_response(id, result, MAX_DEVICE_RESULT_BYTES)?,
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::BROWSER_SCREENSHOT => {
            let result = match kcoder_app_rpc_codec::decode::<BrowserSessionParams>(params) {
                Ok(params) => browsers.screenshot(params).await,
                Err(error) => Err(error).context("invalid browser/screenshot params"),
            };
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        browser_success_response(id, result, MAX_DEVICE_RESULT_BYTES)?,
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::BROWSER_ACTION => {
            let result = match kcoder_app_rpc_codec::decode::<BrowserActionParams>(params) {
                Ok(params) => browsers.action(params).await,
                Err(error) => Err(error).context("invalid browser/action params"),
            };
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        browser_success_response(id, result, MAX_DEVICE_RESULT_BYTES)?,
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::BROWSER_EVALUATE => {
            let result = match kcoder_app_rpc_codec::decode::<BrowserEvaluateParams>(params) {
                Ok(params) => browsers.evaluate(params).await,
                Err(error) => Err(error).context("invalid browser/evaluate params"),
            };
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        browser_success_response(id, result, MAX_DEVICE_RESULT_BYTES)?,
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::BROWSER_CLOSE => {
            let result = match kcoder_app_rpc_codec::decode::<BrowserSessionParams>(params) {
                Ok(params) => browsers.close(params).await,
                Err(error) => Err(error).context("invalid browser/close params"),
            };
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        browser_success_response(id, result, MAX_DEVICE_RESULT_BYTES)?,
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn rejected_start_and_profile_gate_do_not_read_configuration() {
        let root = tempfile::tempdir().unwrap();
        let session = AppState::new(root.path());
        let mut browsers = BrowserRegistry::new();
        let (sender, mut receiver) = mpsc::channel(2);
        let configuration = || panic!("configuration must only be read for a valid native start");
        for (method, code) in [
            (method::BROWSER_START, -32602),
            (
                kcoder_app_protocol::browser_profiles::BROWSER_PROFILE_CONTROL_READ,
                -32085,
            ),
        ] {
            dispatch(
                method,
                json!(method),
                Value::Null,
                &session,
                &configuration,
                &sender,
                &mut browsers,
                None,
            )
            .await
            .unwrap();
            let rejected = receiver.recv().await.unwrap();
            assert_eq!(rejected["id"], method);
            assert_eq!(rejected["error"]["code"], code);
        }
    }
}
