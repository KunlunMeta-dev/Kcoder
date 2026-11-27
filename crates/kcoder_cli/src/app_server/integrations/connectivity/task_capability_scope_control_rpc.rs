//! Exact live source methods use the original resident owner on an owned job.
use super::task_capability_scope_control::NativeTaskCapabilityScopeControlMethod;
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{
    AppServerEngineFactory, ConnectionState, ThreadManager, error_response, send, success_response,
};
use anyhow::{Result, ensure};
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_types::integrations::core::*;
use serde_json::Value;
use tokio::sync::mpsc;

pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    threads: &ThreadManager,
    configuration: &AppServerEngineFactory,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    let bare = match method {
        "integrations/tasks/readTaskSources" => "readTaskSources",
        "integrations/tasks/setTaskSources" => "setTaskSources",
        "integrations/tasks/readTaskSourceOperation" => "readTaskSourceOperation",
        _ => return Ok(false),
    };
    let method = NativeTaskCapabilityScopeControlMethod::from_wire(bare)
        .expect("three fixed source methods");
    let prepared = (|| -> Result<_> {
        ensure!(
            state.integration_task_capability_scope_v1 && state.knowledge_rpc_tasks.len() < 64,
            "TASK_CAPABILITY_SCOPE_UNAVAILABLE"
        );
        let request: IntegrationRequest = rpc_codec::decode(params.clone())?;
        let source = state
            .integration_task_capability_scope
            .clone()
            .capture_public_control(state, request.clone(), method, threads, configuration)?;
        Ok((request, source))
    })();
    let (request, source) = match prepared {
        Ok(value) => value,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32077, "TASK_CAPABILITY_SCOPE_UNAVAILABLE"),
            )
            .await?;
            return Ok(true);
        }
    };
    let (id, outbound) = (id.clone(), outbound.clone());
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let result = source.run().await.and_then(|value| {
            value
                .as_object()
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_UNAVAILABLE"))
        });
        let successful = result.is_ok();
        let reply = IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id,
            operation_id: request
                .operation_id
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            status: if successful {
                IntegrationStatus::Completed
            } else {
                IntegrationStatus::Unavailable
            },
            entity_revision: IntegrationNullable::Null,
            observed_at: chrono::Utc::now().to_rfc3339(),
            result: result
                .ok()
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            error: if successful {
                IntegrationNullable::Null
            } else {
                IntegrationNullable::Value(IntegrationError {
                    code: "TASK_CAPABILITY_SCOPE_UNAVAILABLE".into(),
                    recovery: IntegrationRecovery::ReconcileOriginal,
                    message_key: "integrations.tasks.sourcesUnavailable".into(),
                })
            },
        };
        let value = serde_json::to_value(reply)
            .map(|value| success_response(id.clone(), value))
            .unwrap_or_else(|_| error_response(id, -32077, "TASK_CAPABILITY_SCOPE_UNAVAILABLE"));
        let _ = send(&outbound, value).await;
    });
    Ok(true)
}
