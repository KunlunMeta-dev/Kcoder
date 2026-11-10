//! Terminal RPC execution after the host routes an authorized request.

use crate::terminal::{
    TerminalRegistry, attach as terminal_attach, close as terminal_close, list as terminal_list,
    resize as terminal_resize, start as terminal_start, write as terminal_write,
};
use anyhow::{Context, Result};
use kcoder_app_protocol::{
    TerminalAttachParams, TerminalCloseParams, TerminalListParams, TerminalResizeParams,
    TerminalStartParams, TerminalWriteParams, method,
};
use kcoder_host_transport::protocol_io::{error_response, send, success_response};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::sync::mpsc;

/// Read the current session only after a valid terminal/start request is decoded.
pub async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    start_identity: &(dyn Fn() -> (PathBuf, String) + Sync),
    outbound_tx: &mpsc::Sender<Value>,
    next_terminal_id: &AtomicU64,
    terminals: &TerminalRegistry,
) -> Result<()> {
    match method {
        method::TERMINAL_START => {
            let result = match kcoder_app_rpc_codec::decode::<TerminalStartParams>(params) {
                Ok(params) => {
                    let (cwd, session_id) = start_identity();
                    terminal_start(
                        &cwd,
                        &session_id,
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
            let result = kcoder_app_rpc_codec::decode::<TerminalListParams>(params)
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
            let result = kcoder_app_rpc_codec::decode::<TerminalAttachParams>(params)
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
            let result = kcoder_app_rpc_codec::decode::<TerminalWriteParams>(params)
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
            let result = kcoder_app_rpc_codec::decode::<TerminalResizeParams>(params)
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
            let result = kcoder_app_rpc_codec::decode::<TerminalCloseParams>(params)
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
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn rejected_start_and_list_do_not_read_start_identity() {
        let terminals = TerminalRegistry::default();
        let counter = AtomicU64::new(5);
        let (sender, mut receiver) = mpsc::channel(2);
        let start_identity = || panic!("start identity must only be read for a valid start");
        dispatch(
            method::TERMINAL_START,
            json!("invalid-start"),
            Value::Null,
            &start_identity,
            &sender,
            &counter,
            &terminals,
        )
        .await
        .unwrap();
        let rejected = receiver.recv().await.unwrap();
        assert_eq!(rejected["id"], "invalid-start");
        assert_eq!(rejected["error"]["code"], -32602);
        assert_eq!(counter.load(Ordering::Relaxed), 5);
        dispatch(
            method::TERMINAL_LIST,
            json!("list"),
            json!({}),
            &start_identity,
            &sender,
            &counter,
            &terminals,
        )
        .await
        .unwrap();
        let listed = receiver.recv().await.unwrap();
        assert_eq!(listed["id"], "list");
        assert!(listed.get("result").is_some());
        assert_eq!(terminals.resource_count(), Some(0));
    }
}
