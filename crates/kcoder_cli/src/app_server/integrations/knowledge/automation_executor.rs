use super::api::{dispatch, operation};
use super::automation_api::preview_draft;
use super::{KnowledgeDependencyPort, KnowledgeHostContext, KnowledgeResource};
use anyhow::{Result, ensure};
use kcoder_app_protocol::integrations::knowledge::AutomationTriggerParams;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_state::integrations::knowledge::AutomationStore;
use kcoder_types::integrations::{core::*, knowledge::*};
use kcoder_workflow::store::WorkflowStore;
use serde_json::{Value, json};
use sha2::Digest;
use tokio_util::sync::CancellationToken;

/// A trigger proof is made only by the native scheduler/event ingress or explicit UI action.
/// It is not deserializable and carries no authority beyond its already approved subscription.
pub struct ApprovedSubscriptionTrigger {
    owner: KnowledgeOwner,
    subscription_id: String,
    revision: u64,
    trigger_id: String,
    event_source: Option<String>,
    event_sequence: Option<u64>,
    event_occurred_at_ms: Option<u64>,
    originating_subscription: Option<String>,
    causation_depth: u8,
}
impl ApprovedSubscriptionTrigger {
    pub fn from_native_scheduler(
        scope: &IntegrationScope,
        sub: &AutomationSubscription,
    ) -> Result<Self> {
        let time = sub
            .next_fire_at_ms
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NEXT_FIRE_MISSING"))?;
        ensure!(
            sub.owner == KnowledgeOwner::from(scope)
                && sub.enabled
                && sub.draft.schedule.is_some()
                && !sub.consent_ref.is_empty(),
            "AUTOMATION_CONSENT_MISMATCH"
        );
        Ok(Self {
            owner: sub.owner.clone(),
            subscription_id: sub.draft.id.clone(),
            revision: sub.revision,
            trigger_id: format!("scheduled-{time}"),
            event_source: None,
            event_sequence: None,
            event_occurred_at_ms: None,
            originating_subscription: None,
            causation_depth: 0,
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn from_native_event(
        scope: &IntegrationScope,
        sub: &AutomationSubscription,
        event_source: &str,
        event_id: &str,
        sequence: u64,
        occurred_at_ms: u64,
        originating_subscription: Option<&str>,
        causation_depth: u8,
    ) -> Result<Self> {
        ensure!(
            sub.owner == KnowledgeOwner::from(scope)
                && sub.enabled
                && sub.draft.event_source.as_deref() == Some(event_source)
                && !sub.consent_ref.is_empty(),
            "AUTOMATION_CONSENT_MISMATCH"
        );
        ensure!(
            sequence > 0
                && originating_subscription != Some(sub.draft.id.as_str())
                && causation_depth <= 8,
            "AUTOMATION_EVENT_LOOP_REJECTED"
        );
        ensure!(
            !event_id.is_empty() && event_id.len() <= 256,
            "AUTOMATION_INVALID_ID"
        );
        Ok(Self {
            owner: sub.owner.clone(),
            subscription_id: sub.draft.id.clone(),
            revision: sub.revision,
            trigger_id: event_id.into(),
            event_source: Some(event_source.into()),
            event_sequence: Some(sequence),
            event_occurred_at_ms: Some(occurred_at_ms),
            originating_subscription: originating_subscription.map(str::to_owned),
            causation_depth,
        })
    }
    pub fn params(&self, facts: Value) -> AutomationTriggerParams {
        AutomationTriggerParams {
            subscription_id: self.subscription_id.clone(),
            subscription_revision: self.revision,
            trigger_id: self.trigger_id.clone(),
            trigger_facts: facts,
        }
    }
}
fn resource(store: &AutomationStore, id: &str) -> KnowledgeResource {
    KnowledgeResource {
        kind: "automation",
        id: id.into(),
        owner: store.owner().clone(),
    }
}
fn child_request(
    parent: &IntegrationRequest,
    operation_id: Option<&str>,
    payload: Value,
) -> Result<IntegrationRequest> {
    Ok(IntegrationRequest {
        contract_version: parent.contract_version,
        request_id: uuid::Uuid::new_v4().to_string(),
        scope: parent.scope.clone(),
        operation_id: operation_id.map(str::to_owned),
        expected_revision: None,
        timeout_ms: parent.timeout_ms,
        cancellation_ref: parent.cancellation_ref.clone(),
        payload: payload
            .as_object()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INVALID_PAYLOAD"))?,
    })
}
async fn bounded_call(
    port: &dyn KnowledgeDependencyPort,
    which: IntegrationPort,
    method: &str,
    request: &IntegrationRequest,
    cancel: &CancellationToken,
) -> Result<IntegrationReply> {
    request.validate_method(which, method)?;
    let reply = tokio::select! {
        _=cancel.cancelled()=>anyhow::bail!("AUTOMATION_DEPENDENCY_UNCONFIRMED"),
        result=tokio::time::timeout(std::time::Duration::from_millis(request.timeout_ms),port.call(which,method,request))=>result.map_err(|_|anyhow::anyhow!("AUTOMATION_DEPENDENCY_UNCONFIRMED")),
    }?;
    super::dependencies::validate_dependency_reply(request, &reply)?;
    Ok(reply)
}
fn result_value(reply: &IntegrationReply) -> Result<Value> {
    reply
        .result
        .as_ref()
        .cloned()
        .map(Value::Object)
        .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NATIVE_RECEIPT_INVALID"))
}
fn record_task(
    store: &AutomationStore,
    run: &AutomationRun,
    task: IntegrationRuntimeTask,
    now: u64,
) -> Result<AutomationRun> {
    ensure!(
        run.native_thread_id.as_deref() == Some(task.thread_id.as_str())
            && run
                .native_turn_id
                .as_ref()
                .is_none_or(|t| task.turn_id.as_ref() == Some(t)),
        "AUTOMATION_NATIVE_RECEIPT_CONFLICT"
    );
    if let Some(acceptance) = store.read_native_acceptance(&run.id)? {
        ensure!(
            acceptance.thread_id == task.thread_id
                && acceptance
                    .turn_id
                    .as_ref()
                    .is_none_or(|turn| task.turn_id.as_ref() == Some(turn)),
            "AUTOMATION_NATIVE_RECEIPT_CONFLICT"
        );
        ensure!(
            acceptance
                .task_id
                .as_ref()
                .is_none_or(|id| task.task_id.as_ref() == Some(id)),
            "AUTOMATION_NATIVE_RECEIPT_CONFLICT"
        );
    }
    ensure!(
        task.artifact_refs
            .iter()
            .all(|a| a.kind == IntegrationEntityKind::Artifact),
        "AUTOMATION_NATIVE_RECEIPT_INVALID"
    );
    let state = match task.state {
        IntegrationTaskState::Queued => AutomationRunStatus::Accepted,
        IntegrationTaskState::Running => AutomationRunStatus::Running,
        IntegrationTaskState::WaitingForUser => AutomationRunStatus::Waiting,
        IntegrationTaskState::Completed => AutomationRunStatus::Completed,
        IntegrationTaskState::Failed => AutomationRunStatus::Failed,
        IntegrationTaskState::Cancelled => AutomationRunStatus::Cancelled,
        IntegrationTaskState::OutcomeUnknown => AutomationRunStatus::Unknown,
    };
    store.record_artifact_manifests(&run.id, task.artifact_refs.clone())?;
    store.record_native_status(
        &run.id,
        state,
        task.output,
        task.artifact_refs.into_iter().map(|a| a.id).collect(),
        now,
    )
}
async fn read_native_task(
    parent: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    port: &dyn KnowledgeDependencyPort,
    run: &AutomationRun,
    cancel: &CancellationToken,
) -> Result<AutomationRun> {
    ctx.check(
        parent,
        false,
        "automation.read",
        &resource(store, &run.subscription_id),
    )?;
    let acceptance = match store.read_native_acceptance(&run.id)? {
        Some(acceptance) => acceptance,
        None => {
            let child =
                child_request(parent, None, json!({"operationId":run.native_operation_id}))?;
            let observed = bounded_call(
                port,
                IntegrationPort::Runtime,
                "readOperation",
                &child,
                cancel,
            )
            .await?;
            if observed.status != IntegrationStatus::Completed {
                return store.record_unknown(
                    &run.id,
                    "AUTOMATION_NATIVE_EXACT_REFERENCE_REQUIRED",
                    ctx.now_ms,
                );
            }
            let value = result_value(&observed)?;
            let observed: IntegrationOperationReadResult = rpc_codec::decode(value)
                .map_err(|_| anyhow::anyhow!("AUTOMATION_NATIVE_RECEIPT_INVALID"))?;
            let receipt = match observed.receipt {
                IntegrationNullable::Null => None,
                IntegrationNullable::Value(receipt) => Some(receipt),
            };
            let Some(receipt) = receipt else {
                return store.record_unknown(
                    &run.id,
                    "AUTOMATION_NATIVE_EXACT_REFERENCE_REQUIRED",
                    ctx.now_ms,
                );
            };
            ensure!(
                receipt.operation_id == run.native_operation_id
                    && receipt.port == "P-RUNTIME"
                    && receipt.method == "acceptTask"
                    && KnowledgeOwner::from(&receipt.scope) == *store.owner(),
                "AUTOMATION_NATIVE_RECEIPT_INVALID"
            );
            let Some(acceptance) = receipt.runtime_acceptance else {
                return store.record_unknown(
                    &run.id,
                    "AUTOMATION_NATIVE_EXACT_REFERENCE_REQUIRED",
                    ctx.now_ms,
                );
            };
            store.record_native_acceptance_receipt(&run.id, &acceptance, ctx.now_ms)?;
            acceptance
        }
    };
    ensure!(
        acceptance.turn_id.is_some() || acceptance.task_id.is_some(),
        "AUTOMATION_NATIVE_EXACT_REFERENCE_REQUIRED"
    );
    let reference = IntegrationRuntimeReadTaskParams {
        thread_id: Some(acceptance.thread_id),
        turn_id: acceptance.turn_id,
        task_id: acceptance.task_id,
    };
    reference
        .validate()
        .map_err(|_| anyhow::anyhow!("AUTOMATION_NATIVE_EXACT_REFERENCE_REQUIRED"))?;
    let child = child_request(parent, None, serde_json::to_value(reference)?)?;
    let reply = bounded_call(port, IntegrationPort::Runtime, "readTask", &child, cancel).await?;
    ensure!(
        reply.status == IntegrationStatus::Completed,
        "AUTOMATION_DEPENDENCY_UNCONFIRMED"
    );
    let task: IntegrationRuntimeTask = rpc_codec::decode(result_value(&reply)?)
        .map_err(|_| anyhow::anyhow!("AUTOMATION_NATIVE_RECEIPT_INVALID"))?;
    record_task(store, run, task, ctx.now_ms)
}
/// Called by the existing scheduler or explicit domain RPC, not by a separate timer.
#[allow(clippy::too_many_arguments)]
pub async fn trigger_approved_subscription(
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    workflows: &WorkflowStore,
    port: &dyn KnowledgeDependencyPort,
    proof: &ApprovedSubscriptionTrigger,
    cancel: &CancellationToken,
) -> IntegrationReply {
    let performed=async {
        request.validate_method(IntegrationPort::Automation,"triggerApprovedSubscription")?;
        operation(request)?;
        let p:AutomationTriggerParams=super::api::parse(request)?;
        ctx.check(request,true,"automation.trigger",&resource(store,&p.subscription_id))?;
        ensure!(*store.owner()==KnowledgeOwner::from(ctx.scope)&&proof.owner==*store.owner()&&proof.subscription_id==p.subscription_id&&proof.revision==p.subscription_revision&&proof.trigger_id==p.trigger_id,"AUTOMATION_CONSENT_MISMATCH");
        ensure!(!cancel.is_cancelled(),"AUTOMATION_CANCELLED_BEFORE_SUBMISSION");
        ensure!(port.registered(IntegrationPort::Runtime,"acceptTask")&&port.registered(IntegrationPort::Runtime,"readOperation")&&port.registered(IntegrationPort::Runtime,"readTask"),"AUTOMATION_RUNTIME_UNAVAILABLE");
        let sub=store.read_subscription_version(&p.subscription_id,p.subscription_revision)?;
        ensure!(sub.draft.event_source==proof.event_source&&!sub.consent_ref.is_empty(),"AUTOMATION_CONSENT_MISMATCH");
        // Resolve the actual saved definition and validate inputs before preparing a run.
        let next=if sub.draft.schedule.is_some() { preview_draft(&sub.draft,workflows,ctx.now_ms)? } else {preview_draft(&sub.draft,workflows,ctx.now_ms)?;None};
        let event_sequence = if let Some(source)=&proof.event_source && proof.event_sequence.is_some() {
            let at=proof.event_occurred_at_ms.ok_or_else(||anyhow::anyhow!("AUTOMATION_EVENT_TIME_REQUIRED"))?;
            let sequence=proof.event_sequence.ok_or_else(||anyhow::anyhow!("AUTOMATION_EVENT_SEQUENCE_REQUIRED"))?;
            store.admit_verified_event(&p.subscription_id,p.subscription_revision,source,sequence,&p.trigger_id,at,&p.trigger_facts,proof.originating_subscription.as_deref(),proof.causation_depth,ctx.now_ms)?;
            store.validate_event_sequence(&p.subscription_id,p.subscription_revision,source,sequence,&p.trigger_id)?;
            Some(sequence)
        } else {None};
        let run=store.prepare_run(&p.subscription_id,p.subscription_revision,&p.trigger_id,p.trigger_facts,next,ctx.now_ms)?;
        if let (Some(source),Some(sequence))=(&proof.event_source,event_sequence) {store.checkpoint_event(&p.subscription_id,p.subscription_revision,source,sequence,&p.trigger_id,&run.id)?;}
        if matches!(run.status,AutomationRunStatus::Completed|AutomationRunStatus::Failed|AutomationRunStatus::Cancelled) {return Ok(run);}
        if run.native_thread_id.is_some() {return read_native_task(request,ctx,store,port,&run,cancel).await;}
        let first=store.claim_native_submission(&run.id)?;
        if first {
            let current=store.read_subscription(&p.subscription_id)?;
            if !current.enabled || current.revision!=run.subscription_revision {return store.record_submission_rejection(&run.id,ctx.now_ms);}
        }
        let observed = async {
        let (method,child)=if first {
            let mut payload=json!({"kind":"workflow","workflowId":sub.draft.workflow_id,"workflowVersion":sub.draft.workflow_version,"inputs":sub.draft.inputs,"maximumTokens":sub.draft.maximum_tokens,"maximumRuntimeSeconds":sub.draft.maximum_runtime_seconds,"source":{"kind":"automation","subscriptionId":sub.draft.id,"subscriptionRevision":sub.revision,"runId":run.id,"consentRef":sub.consent_ref}});
            if let Some(selection)=&sub.draft.model_selection {payload["modelSelection"]=serde_json::to_value(selection)?;}
            ("acceptTask",child_request(request,Some(&run.native_operation_id),payload)?)
        } else {("readOperation",child_request(request,None,json!({"operationId":run.native_operation_id}))?)};
        ctx.check(request,true,"automation.trigger",&resource(store,&p.subscription_id))?;
        let reply=match bounded_call(port,IntegrationPort::Runtime,method,&child,cancel).await {
            Ok(reply)=>reply,
            Err(error)=>{store.record_unknown(&run.id,"AUTOMATION_DEPENDENCY_UNCONFIRMED",ctx.now_ms)?;return Err(error);}
        };
        if first&&reply.status==IntegrationStatus::Rejected {return store.record_submission_rejection(&run.id,ctx.now_ms);}
        if !matches!(reply.status,IntegrationStatus::Accepted|IntegrationStatus::Completed) {
            return store.record_unknown(&run.id,"AUTOMATION_DEPENDENCY_UNCONFIRMED",ctx.now_ms);
        }
        if first {ensure!(reply.operation_id.as_ref()==Some(&run.native_operation_id),"AUTOMATION_NATIVE_RECEIPT_INVALID");}
        let value=result_value(&reply)?;
        if first {
            let acceptance:IntegrationRuntimeAcceptance=serde_json::from_value(value).map_err(|_|anyhow::anyhow!("AUTOMATION_NATIVE_RECEIPT_INVALID"))?;
            return store.record_native_acceptance_receipt(&run.id,&acceptance,ctx.now_ms);
        }
        let observed:IntegrationOperationReadResult=rpc_codec::decode(value).map_err(|_|anyhow::anyhow!("AUTOMATION_NATIVE_RECEIPT_INVALID"))?;
        if let IntegrationNullable::Value(receipt)=observed.receipt {
            ensure!(receipt.operation_id==run.native_operation_id&&receipt.port=="P-RUNTIME"&&receipt.method=="acceptTask"&&KnowledgeOwner::from(&receipt.scope)==*store.owner(),"AUTOMATION_NATIVE_RECEIPT_INVALID");
            if receipt.phase==IntegrationOperationPhase::Rejected {return store.record_submission_rejection(&run.id,ctx.now_ms);}
            if let Some(acceptance)=receipt.runtime_acceptance {
                let recovered=store.record_native_acceptance_receipt(&run.id,&acceptance,ctx.now_ms)?;
                return read_native_task(request,ctx,store,port,&recovered,cancel).await;
            }
        }
        store.record_unknown(&run.id,"AUTOMATION_NATIVE_RECEIPT_INVALID",ctx.now_ms)
        }.await;
        match observed {
            Ok(record) => Ok(record),
            Err(_) => store.record_unknown(&run.id,"AUTOMATION_DEPENDENCY_UNCONFIRMED",ctx.now_ms).map_err(|_|anyhow::anyhow!("AUTOMATION_DEPENDENCY_UNCONFIRMED")),
        }
    }.await;
    let id = request
        .payload
        .get("subscriptionId")
        .and_then(Value::as_str)
        .unwrap_or("subscriptions");
    dispatch(
        request,
        ctx,
        true,
        "automation.trigger",
        resource(store, id),
        || {
            let run = performed?;
            Ok((json!({"run":run}), None))
        },
    )
}
/// Reconciles an accepted native task; a read never launches or retries it.
pub async fn refresh_automation_run(
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    port: &dyn KnowledgeDependencyPort,
    run_id: &str,
    cancel: &CancellationToken,
) -> IntegrationReply {
    let result = async {
        ctx.check(request, false, "automation.read", &resource(store, run_id))?;
        let run = store.read_run(run_id)?;
        if run.native_thread_id.is_none() {
            return Ok(run);
        }
        read_native_task(request, ctx, store, port, &run, cancel).await
    }
    .await;
    dispatch(
        request,
        ctx,
        false,
        "automation.read",
        resource(store, run_id),
        || Ok((json!({"run":result?}), None)),
    )
}

/// Explicit owner cancellation observes native acknowledgement; it never invents a cancelled task.
pub async fn cancel_automation_run(
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    port: &dyn KnowledgeDependencyPort,
    run_id: &str,
    cancel: &CancellationToken,
) -> IntegrationReply {
    let result = async {
        ctx.check(request, true, "automation.cancel", &resource(store, run_id))?;
        ensure!(
            ctx.explicit_user_action,
            "AUTOMATION_EXPLICIT_CONSENT_REQUIRED"
        );
        let run = store.read_run(run_id)?;
        ensure!(
            port.registered(IntegrationPort::Runtime, "cancelTask"),
            "AUTOMATION_RUNTIME_UNAVAILABLE"
        );
        ensure!(
            run.native_thread_id.is_some(),
            "AUTOMATION_CANCEL_RECONCILIATION_REQUIRED"
        );
        let acceptance = store
            .read_native_acceptance(run_id)?
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_CANCEL_RECONCILIATION_REQUIRED"))?;
        let reference = IntegrationRuntimeReadTaskParams {
            thread_id: Some(acceptance.thread_id),
            turn_id: acceptance.turn_id,
            task_id: acceptance.task_id,
        };
        reference.validate()?;
        let child = child_request(
            request,
            Some(operation(request)?),
            serde_json::to_value(reference)?,
        )?;
        let response =
            bounded_call(port, IntegrationPort::Runtime, "cancelTask", &child, cancel).await?;
        if response.status == IntegrationStatus::Completed
            && let Ok(task) = rpc_codec::decode::<IntegrationRuntimeTask>(result_value(&response)?)
        {
            return record_task(store, &run, task, ctx.now_ms);
        }
        // Cancel-request acceptance is not terminal cancellation. Read the original task next.
        store.record_unknown(run_id, "AUTOMATION_CANCEL_UNCONFIRMED", ctx.now_ms)
    }
    .await;
    dispatch(
        request,
        ctx,
        true,
        "automation.cancel",
        resource(store, run_id),
        || Ok((json!({"run":result?}), None)),
    )
}

/// Bounded work performed by the existing owned scheduler tick; no new resident loop is spawned.
pub async fn process_due_subscriptions(
    request_template: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    workflows: &WorkflowStore,
    port: &dyn KnowledgeDependencyPort,
    cancel: &CancellationToken,
) -> Result<Vec<IntegrationReply>> {
    ctx.check(
        request_template,
        false,
        "automation.read",
        &resource(store, "subscriptions"),
    )?;
    let subscriptions = store.due_subscriptions(ctx.now_ms)?;
    let mut results = Vec::new();
    for subscription in subscriptions {
        if cancel.is_cancelled() {
            break;
        }
        let proof = ApprovedSubscriptionTrigger::from_native_scheduler(ctx.scope, &subscription)?;
        let payload = serde_json::to_value(
            proof.params(json!({"scheduledAtMs":subscription.next_fire_at_ms})),
        )?;
        let trigger_identity = format!(
            "automation-tick-{:x}",
            sha2::Sha256::digest(serde_json::to_vec(&(
                &subscription.owner,
                &subscription.draft.id,
                subscription.revision,
                &proof.trigger_id
            ))?)
        );
        let request = child_request(request_template, Some(&trigger_identity), payload)?;
        results.push(
            trigger_approved_subscription(&request, ctx, store, workflows, port, &proof, cancel)
                .await,
        );
    }
    Ok(results)
}

/// Restores durable work using the same native operation; no unknown submission is replayed.
pub async fn resume_prepared_automations(
    request_template: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    workflows: &WorkflowStore,
    port: &dyn KnowledgeDependencyPort,
    cancel: &CancellationToken,
) -> Result<Vec<IntegrationReply>> {
    ctx.check(
        request_template,
        false,
        "automation.read",
        &resource(store, "subscriptions"),
    )?;
    let mut replies = Vec::new();
    for run in store.unsettled_runs()? {
        if cancel.is_cancelled() {
            break;
        }
        if run.native_thread_id.is_some() {
            replies.push(
                refresh_automation_run(request_template, ctx, store, port, &run.id, cancel).await,
            );
            continue;
        }
        let sub =
            store.read_subscription_version(&run.subscription_id, run.subscription_revision)?;
        let proof = ApprovedSubscriptionTrigger {
            owner: run.owner.clone(),
            subscription_id: run.subscription_id.clone(),
            revision: run.subscription_revision,
            trigger_id: run.trigger_id.clone(),
            event_source: sub.draft.event_source.clone(),
            event_sequence: None,
            event_occurred_at_ms: None,
            originating_subscription: None,
            causation_depth: 0,
        };
        let payload = serde_json::to_value(proof.params(store.read_run_trigger_facts(&run.id)?))?;
        let request = child_request(request_template, Some(&run.native_operation_id), payload)?;
        replies.push(
            trigger_approved_subscription(&request, ctx, store, workflows, port, &proof, cancel)
                .await,
        );
    }
    Ok(replies)
}

#[cfg(test)]
mod tests;

mod file_events;
pub use file_events::ApprovedFileEventSource;
pub(crate) use file_events::process_selected_file_events_bounded;
