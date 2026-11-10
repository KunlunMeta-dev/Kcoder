//! Finite read-only choices route over the exact original resident owner.
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{
    AppServerEngineFactory, ConnectionState, ThreadManager, error_response, send, success_response,
};
use anyhow::{Result, ensure};
use kcoder_app_protocol::integrations::task_capability_scope::TaskCapabilitySourceChoicesMethod;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_types::integrations::core::*;
use serde_json::Value;
use tokio::sync::mpsc;
pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    threads: &ThreadManager,
    factory: &AppServerEngineFactory,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    if TaskCapabilitySourceChoicesMethod::parse(method).is_none() {
        return Ok(false);
    }
    let prepared = (|| -> Result<_> {
        ensure!(
            state.integration_task_capability_source_choices_v1
                && state.knowledge_rpc_tasks.len() < 64,
            "TASK_CAPABILITY_SOURCE_CHOICES_UNAVAILABLE"
        );
        let request: IntegrationRequest = rpc_codec::decode(params.clone())?;
        let prepared = state
            .integration_task_capability_scope
            .clone()
            .capture_public_choices(state, request.clone(), threads, factory)?;
        Ok((request, prepared))
    })();
    let (request, prepared) = match prepared {
        Ok(value) => value,
        Err(_) => {
            send(
                outbound,
                error_response(
                    id.clone(),
                    -32079,
                    "TASK_CAPABILITY_SOURCE_CHOICES_UNAVAILABLE",
                ),
            )
            .await?;
            return Ok(true);
        }
    };
    let id = id.clone();
    let outbound = outbound.clone();
    let cancel = state.input_ended.child_token();
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let result=tokio::select! {biased;_=cancel.cancelled()=>Err(anyhow::anyhow!("TASK_CAPABILITY_SOURCE_CHOICES_CANCELLED")),
            value=tokio::time::timeout(std::time::Duration::from_millis(request.timeout_ms),prepared.run())=>value.map_err(|_|anyhow::anyhow!("TASK_CAPABILITY_SOURCE_CHOICES_TIMEOUT")).and_then(|v|v)};
        if let Err(error)=&result {tracing::warn!(code=%super::task_capability_scope_runtime::safe_source_error(error),"Task source choices unavailable");}
        let result=result.ok();
        let revision=result.as_ref().map(|page|page.catalog_revision.clone());
        let value=result.and_then(|page|serde_json::to_value(page).ok()).and_then(|page|page.as_object().cloned());
        let successful=value.is_some();
        let reply=IntegrationReply {contract_version:request.contract_version,request_id:request.request_id,operation_id:IntegrationNullable::Null,
            status:if successful{IntegrationStatus::Completed}else{IntegrationStatus::Unavailable},
            entity_revision:revision.map_or(IntegrationNullable::Null,IntegrationNullable::Value),observed_at:chrono::Utc::now().to_rfc3339(),
            result:value.map_or(IntegrationNullable::Null,IntegrationNullable::Value),error:if successful{IntegrationNullable::Null}else{
                IntegrationNullable::Value(IntegrationError {code:"TASK_CAPABILITY_SOURCE_CHOICES_UNAVAILABLE".into(),message_key:"integrations.tasks.sourceChoicesUnavailable".into(),recovery:IntegrationRecovery::RetryRead})}};
        let reply=serde_json::to_value(reply).map(|value|success_response(id.clone(),value)).unwrap_or_else(|_|error_response(id,-32079,"TASK_CAPABILITY_SOURCE_CHOICES_UNAVAILABLE"));
        let _=send(&outbound,reply).await;
    });
    Ok(true)
}
