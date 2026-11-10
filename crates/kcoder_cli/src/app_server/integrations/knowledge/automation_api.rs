use super::api::{dispatch, operation, parse, revision};
use super::{KnowledgeHostContext, KnowledgeResource};
use anyhow::{Result, ensure};
use kcoder_app_protocol::integrations::knowledge::{
    AutomationRunReadParams, SubscriptionEnableParams, SubscriptionSaveParams,
};
use kcoder_state::integrations::knowledge::{ApprovedAutomationConsent, AutomationStore};
use kcoder_types::integrations::{core::*, knowledge::*};
use kcoder_workflow::store::WorkflowStore;
use serde_json::{Value, json};

pub fn preview_draft(
    draft: &AutomationSubscriptionDraft,
    workflows: &WorkflowStore,
    now_ms: u64,
) -> Result<Option<u64>> {
    if let Some(period) = &draft.period_budget {
        period.window(now_ms).map_err(anyhow::Error::msg)?;
    }
    ensure!(
        draft.maximum_tokens > 0
            && draft.maximum_runtime_seconds > 0
            && draft.maximum_runtime_seconds <= 86400,
        "AUTOMATION_BUDGET_REQUIRED"
    );
    ensure!(
        draft.schedule.is_some() != draft.event_source.is_some(),
        "AUTOMATION_ONE_TRIGGER_REQUIRED"
    );
    let definition = super::business_templates::resolve_business_workflow(
        workflows,
        &draft.workflow_id,
        draft.workflow_version,
    )
    .map_err(|_| anyhow::anyhow!("AUTOMATION_WORKFLOW_UNAVAILABLE"))?;
    ensure!(
        definition.saved_version == Some(draft.workflow_version),
        "AUTOMATION_IMMUTABLE_WORKFLOW_REQUIRED"
    );
    kcoder_workflow::graph::prepare_arguments(&definition, &draft.inputs)
        .map_err(|_| anyhow::anyhow!("AUTOMATION_INVALID_INPUTS"))?;
    draft
        .schedule
        .as_ref()
        .map(|s| next_fire(s, now_ms))
        .transpose()
        .map(Option::flatten)
}
pub fn next_fire(schedule: &kcoder_types::CronSchedule, now_ms: u64) -> Result<Option<u64>> {
    let after = i64::try_from(now_ms)
        .ok()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INVALID_CLOCK"))?;
    if let kcoder_types::CronSchedule::At { at } = schedule {
        let at = chrono::DateTime::parse_from_rfc3339(at)
            .map_err(|_| anyhow::anyhow!("AUTOMATION_INVALID_SCHEDULE"))?;
        if at <= after {
            return Ok(None);
        }
    }
    let time = kcoder_schedule::preview_schedule_after(schedule, after)
        .map_err(|_| anyhow::anyhow!("AUTOMATION_INVALID_SCHEDULE"))?;
    Ok(Some(u64::try_from(time.timestamp_millis()).map_err(
        |_| anyhow::anyhow!("AUTOMATION_INVALID_SCHEDULE"),
    )?))
}
pub fn check_destination(
    draft: &AutomationSubscriptionDraft,
    ctx: &KnowledgeHostContext<'_>,
) -> Result<()> {
    if let AutomationDestination::Channel {
        destination_ref,
        destination_revision,
    } = &draft.delivery
    {
        let resource = KnowledgeResource {
            kind: "delivery-destination",
            id: serde_json::to_string(&(destination_ref, destination_revision))?,
            owner: KnowledgeOwner::from(ctx.scope),
        };
        let policy =
            ctx.policy
                .evaluate_action(ctx.scope, "automation.external_delivery", &resource)?;
        ensure!(
            policy.decision == IntegrationPolicyDecision::Allow,
            "AUTOMATION_DESTINATION_DENIED"
        );
    }
    Ok(())
}
pub fn handle_automation_with_source_start(
    method: &str,
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    workflows: &WorkflowStore,
    source_witness: Option<
        std::sync::Arc<dyn kcoder_state::integrations::knowledge::VerifiedAutomationSourceStart>,
    >,
) -> IntegrationReply {
    let mutation = matches!(method, "saveSubscription" | "setSubscriptionEnabled");
    let resource = KnowledgeResource {
        kind: "automation",
        id: request
            .payload
            .get("subscriptionId")
            .and_then(Value::as_str)
            .unwrap_or("subscriptions")
            .into(),
        owner: store.owner().clone(),
    };
    dispatch(
        request,
        ctx,
        mutation,
        if mutation {
            "automation.configure"
        } else {
            "automation.read"
        },
        resource,
        || {
            request.validate_method(IntegrationPort::Automation, method)?;
            ensure!(
                *store.owner() == KnowledgeOwner::from(ctx.scope),
                "AUTOMATION_SCOPE_MISMATCH"
            );
            if mutation {
                ensure!(
                    ctx.explicit_user_action,
                    "AUTOMATION_EXPLICIT_CONSENT_REQUIRED"
                );
            }
            match method {
                "previewSubscription" => {
                    let p: SubscriptionSaveParams = parse(request)?;
                    store.validate_period_configuration(&p.draft)?;
                    check_destination(&p.draft, ctx)?;
                    let next = preview_draft(&p.draft, workflows, ctx.now_ms)?;
                    ensure!(
                        p.draft.schedule.is_none() || next.is_some(),
                        "AUTOMATION_SCHEDULE_IN_PAST"
                    );
                    let mut preview = json!({"nextFireAtMs":next,"workflowId":p.draft.workflow_id,"workflowVersion":p.draft.workflow_version,"maximumTokens":p.draft.maximum_tokens,"maximumRuntimeSeconds":p.draft.maximum_runtime_seconds,"createsSubscription":false});
                    if let Some(selection) = &p.draft.model_selection {
                        preview["modelSelection"] = serde_json::to_value(selection)?;
                    }
                    Ok((preview, None))
                }
                "saveSubscription" => {
                    let p: SubscriptionSaveParams = parse(request)?;
                    store.validate_period_configuration(&p.draft)?;
                    check_destination(&p.draft, ctx)?;
                    let next = preview_draft(&p.draft, workflows, ctx.now_ms)?;
                    ensure!(
                        p.draft.schedule.is_none() || next.is_some(),
                        "AUTOMATION_SCHEDULE_IN_PAST"
                    );
                    let consent = ApprovedAutomationConsent::from_explicit_user_action(
                        ctx.scope,
                        &p.consent_ref,
                        &p.draft,
                    )?;
                    let consent = if let Some(witness) = &source_witness {
                        consent.with_native_source_start(witness.clone())?
                    } else {
                        consent
                    };
                    let sub = store.save_subscription(
                        operation(request)?,
                        revision(request, true)?,
                        p.draft,
                        &consent,
                        next,
                        ctx.now_ms,
                    )?;
                    Ok((json!({"subscription":sub}), Some(sub.revision.to_string())))
                }
                "setSubscriptionEnabled" => {
                    let p: SubscriptionEnableParams = parse(request)?;
                    let old = store.read_subscription(&p.subscription_id)?;
                    if p.enabled {
                        check_destination(&old.draft, ctx)?;
                    }
                    let next = if p.enabled {
                        preview_draft(&old.draft, workflows, ctx.now_ms)?
                    } else {
                        None
                    };
                    ensure!(
                        !p.enabled || old.draft.schedule.is_none() || next.is_some(),
                        "AUTOMATION_SCHEDULE_IN_PAST"
                    );
                    let sub = store.set_subscription_enabled_with_source_start(
                        operation(request)?,
                        &p.subscription_id,
                        revision(request, false)?,
                        p.enabled,
                        next,
                        ctx.now_ms,
                        source_witness.clone(),
                    )?;
                    Ok((json!({"subscription":sub}), Some(sub.revision.to_string())))
                }
                "readAutomationRun" => {
                    let p: AutomationRunReadParams = parse(request)?;
                    let run = store.read_run(&p.run_id)?;
                    Ok((json!({"run":run}), None))
                }
                _ => anyhow::bail!("KNOWLEDGE_METHOD_UNSUPPORTED"),
            }
        },
    )
}
/// Domain management remains separate from the frozen inter-domain method allowlist.
pub fn handle_automation_management(
    method: &str,
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
) -> IntegrationReply {
    let mutation = matches!(method, "removeSubscription" | "hideAutomationRun");
    let resource = KnowledgeResource {
        kind: "automation",
        id: "subscriptions".into(),
        owner: store.owner().clone(),
    };
    dispatch(
        request,
        ctx,
        mutation,
        if mutation {
            "automation.configure"
        } else {
            "automation.read"
        },
        resource,
        || {
            ensure!(
                *store.owner() == KnowledgeOwner::from(ctx.scope),
                "AUTOMATION_SCOPE_MISMATCH"
            );
            if mutation {
                ensure!(
                    ctx.explicit_user_action,
                    "AUTOMATION_EXPLICIT_CONSENT_REQUIRED"
                );
            }
            let id = request.payload.get("id").and_then(Value::as_str);
            match method {
                "listSubscriptions" => Ok((
                    json!({"page":store.list_subscriptions(request.payload.get("after").and_then(Value::as_str))?}),
                    None,
                )),
                "listQuarantinedEvents" => Ok((
                    json!({"page":store.list_quarantined_events(request.payload.get("after").and_then(Value::as_str))?}),
                    None,
                )),
                "readAutomationArtifacts" => Ok((
                    json!({"artifactRefs":store.read_artifact_manifests(id.ok_or_else(||anyhow::anyhow!("KNOWLEDGE_INVALID_PAYLOAD"))?)?}),
                    None,
                )),
                "readAutomationClaims" => Ok((
                    json!({"page":store.read_artifact_claims(id.ok_or_else(||anyhow::anyhow!("KNOWLEDGE_INVALID_PAYLOAD"))?,request.payload.get("after").and_then(Value::as_str))?}),
                    None,
                )),
                "listAutomationRuns" => Ok((
                    json!({"page":store.list_runs(request.payload.get("after").and_then(Value::as_str))?}),
                    None,
                )),
                "removeSubscription" => {
                    store.remove_subscription(
                        operation(request)?,
                        id.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INVALID_PAYLOAD"))?,
                        revision(request, false)?,
                    )?;
                    Ok((json!({"removed":true}), None))
                }
                "hideAutomationRun" => {
                    store.hide_run(
                        operation(request)?,
                        id.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INVALID_PAYLOAD"))?,
                    )?;
                    Ok((json!({"hidden":true}), None))
                }
                _ => anyhow::bail!("KNOWLEDGE_METHOD_UNSUPPORTED"),
            }
        },
    )
}

#[cfg(test)]
#[path = "automation_api/tests.rs"]
mod tests;

/// Read-only template catalog. Listing never creates a workflow, plan, model call or delivery.
pub fn handle_automation_templates(
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
) -> IntegrationReply {
    let resource = KnowledgeResource {
        kind: "automation-templates",
        id: "builtin-office-v1".into(),
        owner: KnowledgeOwner::from(ctx.scope),
    };
    dispatch(request, ctx, false, "automation.read", resource, || {
        let locale = request
            .payload
            .get("locale")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN");
        Ok((
            json!({"templates":super::business_templates::list_business_templates(locale)}),
            None,
        ))
    })
}
