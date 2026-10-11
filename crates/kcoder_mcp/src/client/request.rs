use super::{McpClient, REQUEST_TIMEOUT};
use crate::model::{InboundMessage, JsonRpcRequest, decode_inbound};
use anyhow::{Context, Result};
use kcoder_types::mcp_failure::{McpCallInterruptionReason, McpFailureReason};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;
use tokio_util::sync::CancellationToken;

impl McpClient {
    pub(super) async fn request<T: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: T,
    ) -> Result<R> {
        let id = self.next_id();
        self.request_raw(id, method, params).await
    }

    pub(super) async fn request_raw<T: Serialize, R: DeserializeOwned>(
        &mut self,
        id: u64,
        method: &str,
        params: T,
    ) -> Result<R> {
        self.request_raw_with_cancellation(id, method, params, None)
            .await
    }

    pub(super) async fn request_raw_with_cancellation<T: Serialize, R: DeserializeOwned>(
        &mut self,
        id: u64,
        method: &str,
        params: T,
        cancellation: Option<&CancellationToken>,
    ) -> Result<R> {
        if let Some(reason) = self.connection_failure_reason() {
            return Err(crate::failure::McpFailure {
                reason,
                message: "MCP connection is unavailable; explicitly initialize a new connection",
            }
            .into());
        }
        let line = serde_json::to_string(&JsonRpcRequest::new(id, method, params))
            .context("failed to serialize MCP request")?;
        let mut send_started = false;
        let mut send_complete = false;
        let mut acknowledged = false;
        let mut malformed = false;
        let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
        self.active_request = true;
        let wait = async {
            send_started = true;
            self.transport.send(&line).await?;
            send_complete = true;
            loop {
                let Some(line) = self.transport.recv().await? else {
                    return Err(if malformed {
                        crate::failure::protocol("MCP server returned malformed JSON-RPC response")
                    } else {
                        crate::failure::McpFailure {
                            reason: McpFailureReason::ConnectionFailed,
                            message: "MCP server closed stdout while waiting for response",
                        }
                        .into()
                    });
                };
                if line.trim().is_empty() {
                    continue;
                }
                let message = match decode_inbound(&line) {
                    Ok(message) => message,
                    Err(_) => {
                        malformed = true;
                        tracing::warn!("failed to parse MCP response line");
                        continue;
                    }
                };
                match message {
                    InboundMessage::Notification => continue,
                    InboundMessage::Request {
                        id: server_id,
                        method,
                    } => {
                        let response = if method == "ping" {
                            json!({"jsonrpc":"2.0", "id":server_id, "result":{}})
                        } else {
                            // No sampling, elicitation, or other optional server capabilities were granted.
                            json!({"jsonrpc":"2.0", "id":server_id, "error":{"code":-32601, "message":"Method not supported by this client"}})
                        };
                        self.transport.send(&response.to_string()).await?;
                    }
                    InboundMessage::Response {
                        id: response_id,
                        result,
                        error,
                    } => {
                        if response_id.as_u64() != Some(id) {
                            continue;
                        }
                        if error.is_some() {
                            acknowledged = true;
                            return Err(crate::failure::protocol(
                                "MCP server rejected JSON-RPC request",
                            ));
                        }
                        let decoded =
                            serde_json::from_value(result.expect("validated result envelope"))
                                .map_err(|_| {
                                    crate::failure::protocol("failed to deserialize MCP result")
                                })?;
                        acknowledged = true;
                        return Ok(decoded);
                    }
                }
            }
        };
        let outcome = tokio::select! {
            biased;
            _ = cancelled(cancellation) => Err(McpCallInterruptionReason::Cancelled),
            result = tokio::time::timeout_at(deadline, wait) => match result {
                Ok(result) => Ok(result),
                Err(_) => Err(McpCallInterruptionReason::TimedOut),
            },
        };
        let result = match outcome {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => {
                let reason = crate::failure::failure_reason(&error);
                if !acknowledged {
                    self.failed = Some(reason);
                }
                if method == "tools/call" && send_started && !acknowledged {
                    Err(crate::failure::interrupted(Some(id), reason.into(), false))
                } else {
                    Err(error)
                }
            }
            Err(reason) => {
                // send() preserves pending framing if its future is interrupted. A new send
                // first completes that frame before writing this cancellation notification.
                let notified = if send_started && method != "initialize" {
                    self.notify_cancelled(id).await
                } else {
                    false
                };
                if send_started && (!send_complete || !notified) {
                    // Retire this handle without closing another session's shared transport.
                    self.failed = Some(McpFailureReason::TimedOut);
                }
                if method == "tools/call" {
                    Err(crate::failure::interrupted(
                        send_started.then_some(id),
                        reason,
                        notified,
                    ))
                } else if malformed {
                    self.failed = Some(McpFailureReason::ProtocolFailed);
                    Err(crate::failure::protocol(
                        "MCP server returned malformed JSON-RPC response",
                    ))
                } else {
                    Err(crate::failure::timeout("MCP request timed out after 60s"))
                }
            }
        };
        self.active_request = false;
        result
    }

    async fn notify_cancelled(&mut self, id: u64) -> bool {
        let note = JsonRpcRequest::notification(
            "notifications/cancelled",
            json!({"requestId":id, "reason":"Client stopped waiting; execution outcome is unknown"}),
        );
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            self.transport.send(
                &serde_json::to_string(&note).expect("fixed cancellation notification serializes"),
            ),
        )
        .await
        .is_ok_and(|result| result.is_ok())
    }
}

async fn cancelled(token: Option<&CancellationToken>) {
    match token {
        Some(token) => token.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}
