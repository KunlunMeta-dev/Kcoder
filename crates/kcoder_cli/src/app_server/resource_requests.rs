//! Resource requests: extracted from the app-server connection boundary.

use super::*;

#[expect(
    clippy::too_many_arguments,
    reason = "Keep separately borrowed connection and resource owners explicit at the extracted dispatch boundary"
)]
pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    workspace_engine: &QueryEngine,
    outbound_tx: &mpsc::Sender<Value>,
    next_terminal_id: &AtomicU64,
    terminals: &TerminalRegistry,
    browsers: &mut BrowserRegistry,
) -> Result<DispatchControl> {
    match method {
        method::TERMINAL_START => {
            let result = match serde_json::from_value::<TerminalStartParams>(params) {
                Ok(params) => {
                    terminal_start(
                        &workspace_engine.state.cwd(),
                        &workspace_engine.session_id(),
                        next_terminal_id.fetch_add(1, Ordering::Relaxed),
                        params,
                        terminals.clone(),
                        outbound_tx.clone(),
                    )
                    .await
                }
                Err(error) => Err(error).context("invalid terminal/start params"),
            };
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
        method::TERMINAL_LIST => {
            let result = serde_json::from_value::<TerminalListParams>(params)
                .context("invalid terminal/list params")
                .map(|_| terminal_list(terminals));
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
        method::TERMINAL_ATTACH => {
            let result = serde_json::from_value::<TerminalAttachParams>(params)
                .context("invalid terminal/attach params")
                .and_then(|params| terminal_attach(terminals, params));
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
        method::TERMINAL_WRITE => {
            let result = serde_json::from_value::<TerminalWriteParams>(params)
                .context("invalid terminal/write params")
                .and_then(|params| terminal_write(terminals, params));
            match result {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::TERMINAL_RESIZE => {
            let result = serde_json::from_value::<TerminalResizeParams>(params)
                .context("invalid terminal/resize params")
                .and_then(|params| terminal_resize(terminals, params));
            match result {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::TERMINAL_CLOSE => {
            let result = serde_json::from_value::<TerminalCloseParams>(params)
                .context("invalid terminal/close params")
                .and_then(|params| terminal_close(terminals, params));
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
                    success_response(
                        id,
                        serde_json::to_value(browser::browser_preflight_result())?,
                    ),
                )
                .await?;
            }
        }
        method::BROWSER_START => {
            let result = match serde_json::from_value::<BrowserStartParams>(params) {
                Ok(params) => browsers.start(&workspace_engine.session_id(), params).await,
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
            let result = match serde_json::from_value::<BrowserSessionParams>(params) {
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
            let result = match serde_json::from_value::<BrowserActionParams>(params) {
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
            let result = match serde_json::from_value::<BrowserEvaluateParams>(params) {
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
            let result = match serde_json::from_value::<BrowserSessionParams>(params) {
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
    Ok(DispatchControl::Continue)
}
