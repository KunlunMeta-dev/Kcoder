//! The protocol loop captures native handles; owned blocking work only observes.
use super::*;
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{ConnectionState, error_response, send, success_response};
use anyhow::{Context, ensure};
use kcoder_app_protocol::integrations::task_workspace::TASK_WORKSPACE_READ;
use kcoder_app_rpc_codec as rpc_codec;
use serde_json::Value;
use tokio::sync::mpsc;

pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    workspace: (
        &QueryEngine,
        &crate::app_server::engine_factory::AppServerEngineFactory,
    ),
    threads: &ThreadManager,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    let (workspace, configuration) = workspace;
    if method != TASK_WORKSPACE_READ {
        return Ok(false);
    }
    let prepared = (|| -> Result<_> {
        ensure!(
            state.integration_task_workspace_v1 && state.knowledge_rpc_tasks.len() < 64,
            "TASK_WORKSPACE_UNAVAILABLE"
        );
        let request: IntegrationRequest = rpc_codec::decode(params.clone())?;
        request.validate(false)?;
        let params: TaskWorkspaceReadParams =
            rpc_codec::decode(Value::Object(request.payload.clone()))?;
        let selection = NativeTaskWorkspaceSelection::capture(threads, &params)?;
        ensure!(
            params.task_capability_scope_target.is_none()
                || state.integration_task_workspace_capability_scope_v1,
            "TASK_WORKSPACE_SCOPE_UNAVAILABLE"
        );
        let enrichment = if params.cursor.is_none() {
            enrichment::PreparedEnrichment::capture(
                state,
                &request,
                &params,
                threads,
                configuration,
            )?
        } else {
            None
        };
        let native = state
            .integration_context
            .as_ref()
            .context("TASK_WORKSPACE_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&request.scope)?;
        Ok((request, params, selection, native, enrichment))
    })();
    let (request, params, selection, native, enrichment) = match prepared {
        Ok(prepared) => prepared,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32075, "TASK_WORKSPACE_UNAVAILABLE"),
            )
            .await?;
            return Ok(true);
        }
    };
    let workspace = workspace.clone();
    let reader = state.integration_task_workspace.clone();
    let selection = std::sync::Arc::new(selection);
    let ended = state.input_ended.clone();
    let cancel = ended.child_token();
    let (id, outbound) = (id.clone(), outbound.clone());
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let _cancel_on_drop = cancel.clone().drop_guard();
        let budget = std::time::Duration::from_millis(request.timeout_ms);
        let request_cancel = cancel.clone();
        let result = tokio::time::timeout(budget, async move {
            let fence_native = native.recapture_for_owned_service()?;
            let fence_workspace = workspace.clone();
            let fence_selection = selection.clone();
            let fence_cancel = cancel.clone();
            let fence = crate::app_server::task_spawn::spawn_blocking(move || {
                let source = source::NativeSource::capture(
                    &fence_native,
                    &fence_workspace,
                    &fence_selection,
                )?;
                source.check(&fence_cancel)?;
                source.authority_fence()
            })
            .await
            .map_err(|_| anyhow::anyhow!("TASK_WORKSPACE_UNAVAILABLE"))??;
            let mut observed = if let Some(enrichment) = enrichment {
                match tokio::time::timeout(budget, enrichment.observe(&cancel)).await {
                    Ok(Ok(observed)) => observed,
                    _ if cancel.is_cancelled() => {
                        return Err(anyhow::anyhow!("TASK_WORKSPACE_CANCELLED"));
                    }
                    _ => enrichment::ObservedEnrichment {
                        task_capability_scope_target: params.task_capability_scope_target.clone(),
                        task_capability_scope_reason: Some("TASK_WORKSPACE_SCOPE_TIMEOUT"),
                        runtime_reason: Some("TASK_WORKSPACE_RUNTIME_UNCONFIRMED"),
                        ..Default::default()
                    },
                }
            } else {
                enrichment::ObservedEnrichment::default()
            };
            observed.authority_fence = Some(fence);
            crate::app_server::task_spawn::spawn_blocking(move || {
                ensure!(!cancel.is_cancelled(), "TASK_WORKSPACE_CANCELLED");
                let mut reader = reader
                    .lock()
                    .map_err(|_| anyhow::anyhow!("TASK_WORKSPACE_UNAVAILABLE"))?;
                reader.read_owned_enriched(
                    &native, &workspace, &selection, &params, observed, &cancel,
                )
            })
            .await
            .map_err(|_| anyhow::anyhow!("TASK_WORKSPACE_UNAVAILABLE"))?
        })
        .await;
        if result.is_err() {
            request_cancel.cancel();
        }
        if ended.is_cancelled() {
            return;
        }
        if let Ok(Err(error)) = &result {
            tracing::warn!(error = ?error, "native task workspace observation failed");
        }
        let value = match result {
            Ok(Ok(snapshot)) if !request_cancel.is_cancelled() => serde_json::to_value(snapshot)
                .ok()
                .and_then(|value| value.as_object().cloned()),
            _ => None,
        };
        let successful = value.is_some();
        let reply = IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id,
            status: if successful {
                IntegrationStatus::Completed
            } else {
                IntegrationStatus::Unavailable
            },
            operation_id: request
                .operation_id
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            entity_revision: IntegrationNullable::Null,
            observed_at: chrono::Utc::now().to_rfc3339(),
            result: value.map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            error: if successful {
                IntegrationNullable::Null
            } else {
                IntegrationNullable::Value(IntegrationError {
                    code: "TASK_WORKSPACE_UNAVAILABLE".into(),
                    recovery: IntegrationRecovery::RetryRead,
                    message_key: "integrations.tasks.unavailable".into(),
                })
            },
        };
        let response = match serde_json::to_value(reply) {
            Ok(reply) => success_response(id, reply),
            Err(_) => error_response(id, -32075, "TASK_WORKSPACE_UNAVAILABLE"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
