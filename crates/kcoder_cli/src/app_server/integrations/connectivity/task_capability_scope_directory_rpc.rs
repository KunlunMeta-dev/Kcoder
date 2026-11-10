//! Read-only saved bindings use the existing connection-owned management jobs.
use super::task_capability_scope_directory::NativeSavedTaskCapabilityScopeReader;
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{ConnectionState, error_response, send, success_response};
use anyhow::{Result, ensure};
use kcoder_app_protocol::integrations::task_capability_scope::TASK_CAPABILITY_SCOPE_BINDINGS_READ;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_types::integrations::core::*;
use serde_json::Value;
use std::time::Duration;
use tokio::sync::mpsc;

pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    if method != TASK_CAPABILITY_SCOPE_BINDINGS_READ {
        return Ok(false);
    }
    let prepared = (|| -> Result<_> {
        ensure!(
            state.integration_task_capability_scope_directory_v1,
            "TASK_CAPABILITY_SCOPE_DIRECTORY_UNSUPPORTED"
        );
        ensure!(
            state.knowledge_rpc_tasks.len() < 64,
            "TASK_CAPABILITY_SCOPE_DIRECTORY_BUSY"
        );
        let request: IntegrationRequest = rpc_codec::decode(params.clone())?;
        let reader = NativeSavedTaskCapabilityScopeReader::capture(state, &request)?;
        Ok((request, reader))
    })();
    let (request, reader) = match prepared {
        Ok(value) => value,
        Err(_) => {
            send(
                outbound,
                error_response(
                    id.clone(),
                    -32076,
                    "TASK_CAPABILITY_SCOPE_DIRECTORY_UNAVAILABLE",
                ),
            )
            .await?;
            return Ok(true);
        }
    };
    let (id, outbound) = (id.clone(), outbound.clone());
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let cancel = reader.cancellation();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(anyhow::anyhow!("TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED")),
            result = tokio::time::timeout(Duration::from_millis(request.timeout_ms), reader.read()) => {
                result.map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_DIRECTORY_UNAVAILABLE")).and_then(|result| result)
            }
        };
        let result = result.and_then(|page| {
            serde_json::to_value(page)?.as_object().cloned()
                .ok_or_else(|| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_DIRECTORY_UNAVAILABLE"))
        });
        let code = result.as_ref().err().map(|error| {
            match error.to_string().as_str() {
                "TASK_CAPABILITY_SCOPE_DIRECTORY_CURSOR_INVALID" => "TASK_CAPABILITY_SCOPE_DIRECTORY_CURSOR_INVALID",
                "TASK_CAPABILITY_SCOPE_DIRECTORY_CURSOR_STALE" => "TASK_CAPABILITY_SCOPE_DIRECTORY_CURSOR_STALE",
                "TASK_CAPABILITY_SCOPE_DIRECTORY_OWNER_CHANGED" => "TASK_CAPABILITY_SCOPE_DIRECTORY_OWNER_CHANGED",
                "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED" => "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED",
                "TASK_CAPABILITY_SCOPE_DIRECTORY_BUSY" => "TASK_CAPABILITY_SCOPE_DIRECTORY_BUSY",
                _ => "TASK_CAPABILITY_SCOPE_DIRECTORY_UNAVAILABLE",
            }
        });
        let reply = IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id,
            status: if result.is_ok() { IntegrationStatus::Completed } else { IntegrationStatus::Unavailable },
            operation_id: IntegrationNullable::Null,
            entity_revision: IntegrationNullable::Null,
            observed_at: chrono::Utc::now().to_rfc3339(),
            result: result.ok().map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            error: code.map_or(IntegrationNullable::Null, |code| IntegrationNullable::Value(IntegrationError {
                code: code.into(),
                recovery: IntegrationRecovery::RetryRead,
                message_key: "integrations.tasks.sourcesUnavailable".into(),
            })),
        };
        let response = match serde_json::to_value(reply) {
            Ok(value) => success_response(id, value),
            Err(_) => error_response(id, -32076, "TASK_CAPABILITY_SCOPE_DIRECTORY_UNAVAILABLE"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
