use super::api::dispatch;
use super::{KnowledgeDependencyPort, KnowledgeHostContext, KnowledgeResource};
use anyhow::ensure;
use kcoder_state::integrations::knowledge::AutomationStore;
use kcoder_types::integrations::{core::*, knowledge::*};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// Studio is an independent real inbox. External submission never changes execution success.
pub async fn deliver_automation_run(
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    port: &dyn KnowledgeDependencyPort,
    run_id: &str,
    cancel: &CancellationToken,
) -> IntegrationReply {
    let resource = || KnowledgeResource {
        kind: "automation",
        id: run_id.into(),
        owner: store.owner().clone(),
    };
    let result=async {
        ctx.check(request,true,"automation.deliver",&resource())?;
        let run=store.read_run(run_id)?;
        ensure!(run.status==AutomationRunStatus::Completed,"AUTOMATION_RESULT_NOT_READY");
        let subscription=store.read_subscription_version(&run.subscription_id,run.subscription_revision)?;
        let AutomationDestination::Channel{destination_ref,destination_revision}=subscription.draft.delivery else {return Ok(run);};
        ensure!(port.registered(IntegrationPort::Delivery,"submitDelivery")&&port.registered(IntegrationPort::Delivery,"readDelivery"),"AUTOMATION_DELIVERY_UNAVAILABLE");
        if cancel.is_cancelled(){anyhow::bail!("AUTOMATION_CANCELLED_BEFORE_SUBMISSION");}
        let first=run.delivery_id.is_none();
        let delivery_id=run.delivery_id.clone().unwrap_or_else(||format!("delivery-{}",run.id));
        // Persist the intent first. After restart only read/reconcile this delivery, never re-send it.
        let current=if first{store.record_delivery(run_id,&delivery_id,AutomationDeliveryStatus::Pending,ctx.now_ms)?}else{run};
        let payload=if first {original_delivery_payload(store,&current,&delivery_id,&destination_ref,&destination_revision)?}else{json!({"deliveryId":delivery_id})};
        let child=IntegrationRequest{contract_version:request.contract_version,request_id:uuid::Uuid::new_v4().to_string(),scope:request.scope.clone(),operation_id:first.then(||format!("submit-{delivery_id}")),expected_revision:None,timeout_ms:request.timeout_ms,cancellation_ref:request.cancellation_ref.clone(),payload:payload.as_object().cloned().unwrap()};
        let method=if first{"submitDelivery"}else{"readDelivery"};
        child.validate_method(IntegrationPort::Delivery,method)?;
        ctx.check(request,true,"automation.deliver",&resource())?;
        let reply=tokio::select!{
            _=cancel.cancelled()=>None,
            reply=tokio::time::timeout(std::time::Duration::from_millis(child.timeout_ms),port.call(IntegrationPort::Delivery,method,&child))=>reply.ok(),
        };
        let Some(reply)=reply else{return store.record_delivery(run_id,&delivery_id,AutomationDeliveryStatus::Unknown,ctx.now_ms);};
        if super::dependencies::validate_dependency_reply(&child,&reply).is_err() {
            return store.record_delivery(run_id,&delivery_id,AutomationDeliveryStatus::Unknown,ctx.now_ms);
        }
        if !matches!(reply.status,IntegrationStatus::Accepted|IntegrationStatus::Completed) {
            let state=if first && reply.status==IntegrationStatus::Rejected {AutomationDeliveryStatus::Failed}else{AutomationDeliveryStatus::Unknown};
            return store.record_delivery(run_id,&delivery_id,state,ctx.now_ms);
        }
        let result=reply.result.as_ref().ok_or_else(||anyhow::anyhow!("AUTOMATION_DELIVERY_RECEIPT_INVALID"))?;
        ensure!(result.get("deliveryId").and_then(Value::as_str)==Some(delivery_id.as_str()),"AUTOMATION_DELIVERY_RECEIPT_INVALID");
        let state=match result.get("deliveryState").and_then(Value::as_str) {
            Some("pending"|"sending")=>AutomationDeliveryStatus::Pending,
            Some("accepted")=>AutomationDeliveryStatus::Accepted,
            Some("failed"|"blocked")=>AutomationDeliveryStatus::Failed,
            Some("cancelled")=>AutomationDeliveryStatus::Cancelled,
            Some("unknown")=>AutomationDeliveryStatus::Unknown,
            _=>anyhow::bail!("AUTOMATION_DELIVERY_RECEIPT_INVALID"),
        };
        store.record_delivery(run_id,&delivery_id,state,ctx.now_ms)
    }.await;
    dispatch(request, ctx, true, "automation.deliver", resource(), || {
        Ok((json!({"run":result?}), None))
    })
}

/// C accepts optional text, never JSON null; artifact-only results retain the same original intent.
pub(super) fn original_delivery_payload(
    store: &AutomationStore,
    run: &AutomationRun,
    delivery_id: &str,
    destination_ref: &str,
    destination_revision: &str,
) -> anyhow::Result<Value> {
    let mut content = json!({"artifactRefs":store.read_artifact_manifests(&run.id)?});
    if let Some(output) = &run.output {
        content["text"] = json!(output);
    }
    Ok(
        json!({"deliveryId":delivery_id,"destinationRef":{"id":destination_ref,"revision":destination_revision},
        "content":content,"parentOperationId":run.native_operation_id,
        "subscriptionRef":{"id":run.subscription_id,"revision":run.subscription_revision.to_string()}}),
    )
}

/// The original owner tick advances only existing completed results and reads unknown deliveries by their original IDs.
pub(super) async fn process_pending_deliveries(
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    port: &dyn KnowledgeDependencyPort,
    after: Option<&str>,
    cancel: &CancellationToken,
) -> anyhow::Result<(Vec<IntegrationReply>, Option<String>)> {
    let page = store.pending_delivery_runs(after)?;
    let mut replies = Vec::new();
    for run in page.items {
        if cancel.is_cancelled() {
            break;
        }
        let mut tick_request = request.clone();
        tick_request.request_id = uuid::Uuid::new_v4().to_string();
        tick_request.operation_id = Some(format!("automation-delivery-tick-{}", run.id));
        replies
            .push(deliver_automation_run(&tick_request, ctx, store, port, &run.id, cancel).await);
    }
    Ok((replies, page.next_cursor))
}

/// Explicit user cancellation/reconciliation addresses only the original C delivery.
pub async fn control_automation_delivery(
    method: &str,
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    port: &dyn KnowledgeDependencyPort,
    run_id: &str,
    cancel: &CancellationToken,
) -> IntegrationReply {
    let resource = || KnowledgeResource {
        kind: "automation",
        id: run_id.into(),
        owner: store.owner().clone(),
    };
    let result=async {
        ctx.check(request,true,"automation.deliver",&resource())?;
        ensure!(ctx.explicit_user_action,"AUTOMATION_EXPLICIT_CONSENT_REQUIRED");
        ensure!(matches!(method,"cancelDelivery"|"reconcileDelivery"),"KNOWLEDGE_METHOD_UNSUPPORTED");
        let run=store.read_run(run_id)?;
        let id=run.delivery_id.as_ref().ok_or_else(||anyhow::anyhow!("AUTOMATION_DELIVERY_NOT_SUBMITTED"))?;
        ensure!(port.registered(IntegrationPort::Delivery,method),"AUTOMATION_DELIVERY_UNAVAILABLE");
        let child=IntegrationRequest{contract_version:request.contract_version,request_id:uuid::Uuid::new_v4().to_string(),scope:request.scope.clone(),operation_id:Some(super::api::operation(request)?.into()),expected_revision:None,timeout_ms:request.timeout_ms,cancellation_ref:request.cancellation_ref.clone(),payload:json!({"deliveryId":id}).as_object().unwrap().clone()};
        child.validate_method(IntegrationPort::Delivery,method)?;
        let reply=tokio::select!{
            _=cancel.cancelled()=>None,
            reply=tokio::time::timeout(std::time::Duration::from_millis(child.timeout_ms),port.call(IntegrationPort::Delivery,method,&child))=>reply.ok(),
        };
        let Some(reply)=reply else{return store.record_delivery(run_id,id,AutomationDeliveryStatus::Unknown,ctx.now_ms);};
        if super::dependencies::validate_dependency_reply(&child,&reply).is_err() {
            return store.record_delivery(run_id,id,AutomationDeliveryStatus::Unknown,ctx.now_ms);
        }
        if reply.status==IntegrationStatus::Rejected {anyhow::bail!("AUTOMATION_DELIVERY_EXPLICIT_DECISION_REQUIRED");}
        if !matches!(reply.status,IntegrationStatus::Completed|IntegrationStatus::Accepted){return store.record_delivery(run_id,id,AutomationDeliveryStatus::Unknown,ctx.now_ms);}
        let result=reply.result.as_ref().ok_or_else(||anyhow::anyhow!("AUTOMATION_DELIVERY_RECEIPT_INVALID"))?;
        ensure!(result.get("deliveryId").and_then(Value::as_str)==Some(id.as_str()),"AUTOMATION_DELIVERY_RECEIPT_INVALID");
        let state=match result.get("deliveryState").and_then(Value::as_str){
            Some("pending"|"sending")=>AutomationDeliveryStatus::Pending,Some("accepted")=>AutomationDeliveryStatus::Accepted,
            Some("cancelled")=>AutomationDeliveryStatus::Cancelled,Some("failed"|"blocked")=>AutomationDeliveryStatus::Failed,
            Some("unknown")=>AutomationDeliveryStatus::Unknown,_=>anyhow::bail!("AUTOMATION_DELIVERY_RECEIPT_INVALID"),
        };
        store.record_delivery(run_id,id,state,ctx.now_ms)
    }.await;
    dispatch(request, ctx, true, "automation.deliver", resource(), || {
        Ok((json!({"run":result?}), None))
    })
}

#[cfg(test)]
mod tests;
