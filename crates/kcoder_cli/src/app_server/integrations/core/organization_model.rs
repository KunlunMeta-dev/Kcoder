//! Actual Native Provider admission against the original root account policy and budget.
use anyhow::{Context, Result, ensure};
use kcoder_api::model_budget_input::{effective_output_limit, reservation_input};
use kcoder_engine::{QueryEngine, native_model_requests::*};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_state::integrations::core::budgets::{
    BudgetCharge, BudgetReservationReceipt, BudgetUsageCoverage,
};
use kcoder_types::{MessagesRequest, ModelConfigurationSummary, Usage};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
#[path = "organization_model/tasks.rs"]
mod tasks;
use tasks::OrganizationTasks;

pub fn install(native: &NativeIntegrationContext, engine: QueryEngine) -> Result<QueryEngine> {
    if native.scope().organization_id.is_none() {
        return Ok(engine);
    }
    let observer = Arc::new(OrganizationModelObserver {
        native: Arc::new(native.recapture_for_owned_service()?),
        tasks: Arc::new(Mutex::new(OrganizationTasks::default())),
    });
    engine.with_mandatory_native_model_request_observer(observer)
}

struct OrganizationModelObserver {
    native: Arc<NativeIntegrationContext>,
    tasks: Arc<Mutex<OrganizationTasks>>,
}
struct OrganizationModelLease {
    native: Arc<NativeIntegrationContext>,
    operation: String,
    reservation: String,
    receipt: BudgetReservationReceipt,
    model: ModelConfigurationSummary,
    endpoint: String,
    usage: Option<Usage>,
    updates: u64,
    started: Instant,
    deadline: Instant,
}

fn classify(error: anyhow::Error) -> NativeModelRequestError {
    // Fixed local categories only; do not expose arbitrary provider text,
    // request bodies, endpoints or credentials in admission diagnostics.
    let code = match error.to_string().as_str() {
        "ORGANIZATION_MODEL_ACTOR_CHANGED" => "actor_changed",
        "ORGANIZATION_MODEL_ACCEPTED_ATTEMPT_REQUIRED" => "accepted_attempt_required",
        "ORGANIZATION_MODEL_ATTEMPT_CHANGED" => "attempt_changed",
        "ORGANIZATION_MODEL_DENIED" => "model_denied",
        "ORGANIZATION_ACCEPTED_NOT_ACTIVE" => "accepted_not_active",
        "ORGANIZATION_PARENT_TASK_NOT_ACTIVE" => "parent_not_active",
        "BUDGET_EXHAUSTED" => "budget_exhausted",
        "BUDGET_BUSY" => "budget_busy",
        "AUTOMATION_MODEL_OUTPUT_POLICY_UNAVAILABLE" => "request_output_unavailable",
        _ => "unavailable",
    };
    tracing::warn!(reason_code = code, "Organization model admission refused");
    NativeModelRequestError::Unavailable
}
fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn receipt(value: Value) -> Result<BudgetReservationReceipt> {
    serde_json::from_value(value).context("ORGANIZATION_BUDGET_RECEIPT_INVALID")
}
pub use kcoder_api::model_budget_input::validate_model_input;

impl NativeModelRequestObserver for OrganizationModelObserver {
    fn observe_workflow_accepted(
        &self,
        request: &NativeWorkflowRootRequest<'_>,
    ) -> std::result::Result<(), NativeModelRequestError> {
        self.tasks
            .lock()
            .map_err(|_| NativeModelRequestError::Unavailable)?
            .accept_workflow(&self.native, request)
            .map_err(classify)
    }
    fn retain_auxiliary(
        &self,
        request: &NativeAuxiliaryModelRequest<'_>,
    ) -> std::result::Result<Option<Arc<dyn Send + Sync>>, NativeModelRequestError> {
        OrganizationTasks::retain_auxiliary(&self.tasks, &self.native, request)
            .map(Some)
            .map_err(classify)
    }
    fn observe_child_scheduled(
        &self,
        request: &kcoder_engine::integrations::core::NativeScheduledChildRequest<'_>,
    ) -> std::result::Result<(), NativeModelRequestError> {
        self.tasks
            .lock()
            .map_err(|_| NativeModelRequestError::Unavailable)?
            .schedule(&self.native, request)
            .map_err(classify)
    }
    fn observe_execution_terminal(&self) -> std::result::Result<(), NativeModelRequestError> {
        self.tasks
            .lock()
            .map_err(|_| NativeModelRequestError::Unavailable)?
            .reconcile(&self.native)
            .map_err(classify)
    }
    fn prepare_child(
        &self,
        request: &kcoder_engine::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> std::result::Result<(), NativeModelRequestError> {
        self.tasks
            .lock()
            .map_err(|_| NativeModelRequestError::Unavailable)?
            .prepare_child(&self.native, request)
            .map_err(classify)
    }
    fn observe_child_accepted(
        &self,
        request: &kcoder_engine::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> std::result::Result<(), NativeModelRequestError> {
        self.tasks
            .lock()
            .map_err(|_| NativeModelRequestError::Unavailable)?
            .observe_child(request)
            .map_err(classify)
    }
    fn reserve(
        &self,
        context: &NativeModelRequestContext,
        request: &MessagesRequest,
    ) -> std::result::Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        (|| -> Result<Box<dyn NativeModelRequestLease>> {
            self.native.verify()?;
            ensure!(context.execution().matches_state(context.state()), "ORGANIZATION_MODEL_ACTOR_CHANGED");
            let attempt = context.execution().attempt().cloned().or_else(|| context.state().current_history_attempt_identity())
                .context("ORGANIZATION_MODEL_ACCEPTED_ATTEMPT_REQUIRED")?;
            ensure!(context.state().matches_current_history_attempt(Some(&attempt)), "ORGANIZATION_MODEL_ATTEMPT_CHANGED");
            let model = context.configuration().context("ORGANIZATION_MODEL_CONFIGURATION_REQUIRED")?.clone();
            validate_model_input(&model)?;
            let endpoint = context.provider().endpoint().context("ORGANIZATION_MODEL_ENDPOINT_REQUIRED")?.to_owned();
            self.native.authorize_organization_model(&model, &endpoint, context.call_id())?;
            let task = self.tasks.lock().map_err(|_| anyhow::anyhow!("ORGANIZATION_TASK_BINDING_UNAVAILABLE"))?
                .for_model(&self.native,context,&attempt)?;
            let operation = task.operation.clone();
            let reservation = context.call_id().to_owned();
            let input = reservation_input(request)?;
            let output = u64::from(effective_output_limit(&model, request)?);
            let started = Instant::now();
            let maximum_millis = context.provider().request_timeout_secs().filter(|value| *value > 0)
                .and_then(|seconds| seconds.checked_mul(1000)).context("ORGANIZATION_RUNTIME_BOUND_REQUIRED")?;
            let actor = model_budget_actor(context);
            let reserved = receipt(self.native.organization_budget_request(&operation, json!({
                "kind":"reserve","reservation_id":reservation,"operation_id":context.call_id(),"unit":"model_call",
                "task":{"rootOperationId":operation,"rootTask":task.task,
                    "actor":actor,"actorAttemptId":context.call_id(),"parentReservationId":task.slot},
                "parent":{"receiptId":task.receipt_id,"receiptSha256":task.accepted_sha256},
                "estimate":{"tokens":input.checked_add(output).context("ORGANIZATION_BUDGET_OVERFLOW")?,"modelCalls":1,"runMillis":maximum_millis,"costMicros":null}
            }))?)?;
            let dispatched = receipt(self.native.organization_budget_request(&operation, json!({
                "kind":"dispatch","reservation_id":reservation,"expected_revision":reserved.revision
            }))?)?;
            let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;
            let remaining = dispatched.policy_refs.iter().map(|p| p.window.ends_at_ms.saturating_sub(now_ms)).min().context("ORGANIZATION_BUDGET_WINDOW_REQUIRED")?;
            ensure!(remaining > 0, "ORGANIZATION_BUDGET_WINDOW_EXPIRED");
            let deadline=started.checked_add(Duration::from_millis(maximum_millis.min(remaining))).context("ORGANIZATION_RUNTIME_BOUND_INVALID")?;
            Ok(Box::new(OrganizationModelLease { native:self.native.clone(), operation, reservation, receipt:dispatched, model, endpoint, usage:None, updates:0, started, deadline }))
        })().map_err(classify)
    }
}
fn model_budget_actor(context: &NativeModelRequestContext) -> &'static str {
    if context.retry_attempt() > 0 {
        return "retry";
    }
    match context.purpose() {
        NativeModelRequestPurpose::Main if context.execution().parent().is_some() => "child_agent",
        NativeModelRequestPurpose::Main => "main",
        NativeModelRequestPurpose::Verifier => "verifier",
        NativeModelRequestPurpose::Summary
        | NativeModelRequestPurpose::MemoryObserver
        | NativeModelRequestPurpose::MoaReference
        | NativeModelRequestPurpose::MoaAggregator => "observer",
    }
}
impl OrganizationModelLease {
    fn write(
        &mut self,
        coverage: BudgetUsageCoverage,
        charge: BudgetCharge,
        terminal: Option<Value>,
    ) -> Result<()> {
        self.updates = self
            .updates
            .checked_add(1)
            .context("ORGANIZATION_BUDGET_UPDATE_LIMIT")?;
        self.receipt = receipt(self.native.organization_budget_request(&self.operation, json!({
            "kind":"observe","reservation_id":self.reservation,"expected_revision":self.receipt.revision,
            "update_id":format!("native-observation-{}",self.updates),"coverage":coverage,"usage":charge,"terminal":terminal
        }))?)?;
        Ok(())
    }
    fn charge(&self, dispatched: bool) -> BudgetCharge {
        BudgetCharge {
            tokens: self
                .usage
                .as_ref()
                .map(|u| {
                    u64::from(
                        u.total_tokens
                            .unwrap_or_else(|| u.input_tokens.saturating_add(u.output_tokens)),
                    )
                })
                .unwrap_or(0),
            model_calls: u64::from(dispatched),
            run_millis: self
                .started
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
            cost_micros: None,
        }
    }
}
impl NativeModelRequestLease for OrganizationModelLease {
    fn deadline(&self) -> Option<Instant> {
        Some(self.deadline)
    }
    fn check_current(&self) -> std::result::Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            self.native.authorize_organization_model(
                &self.model,
                &self.endpoint,
                &self.reservation,
            )?;
            self.native.organization_budget_request(
                &self.operation,
                json!({"kind":"check","reservation_id":self.reservation}),
            )?;
            Ok(())
        })()
        .map_err(classify)
    }
    fn record_usage(&mut self, usage: &Usage) -> std::result::Result<(), NativeModelRequestError> {
        if let Some(current) = &mut self.usage {
            current.merge_stream_update(usage)
        } else {
            self.usage = Some(usage.clone())
        }
        self.write(BudgetUsageCoverage::Partial, self.charge(true), None)
            .map_err(classify)
    }
    fn finish(
        mut self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> std::result::Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            if let Some(usage)=settlement.usage.as_ref() { if let Some(current)=&mut self.usage { current.merge_stream_update(usage) } else { self.usage=Some(usage.clone()) } }
            let complete=settlement.end==NativeModelRequestEnd::MessageStop && settlement.usage_from_delta
                && self.usage.as_ref().is_some_and(|u| u.total_tokens.is_some() || u.input_tokens>0 || u.cache_read_input_tokens.unwrap_or(0)>0);
            let terminal=if !settlement.request_dispatched || settlement.end==NativeModelRequestEnd::MessageStop { Some(json!({
                "receiptId":format!("native-model-end-{}",self.reservation),"receiptSha256":digest(&(self.reservation.clone(),format!("{:?}",settlement.end),settlement.request_dispatched))?,
                "kind":if settlement.request_dispatched {"completed"} else {"verified_not_started"}
            })) } else { None };
            let coverage=if !settlement.request_dispatched || complete { BudgetUsageCoverage::Complete } else if self.usage.is_some() {BudgetUsageCoverage::Partial} else {BudgetUsageCoverage::Unreported};
            let charge=if settlement.request_dispatched {self.charge(true)} else {BudgetCharge::zero()};
            self.write(coverage, charge, terminal)
        })().map_err(classify)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unmeasured_message_or_tool_overrides_cannot_cross_organization_admission() {
        let settings = kcoder_config::Settings::default();
        let mut configuration = kcoder_engine::model_configuration_summary(
            &settings,
            kcoder_types::ModelConfigurationBoundary::NextTurn,
        )
        .unwrap();
        for field in [
            "model",
            "messages",
            "system",
            "tools",
            "tool_choice",
            "input",
            "instructions",
            "response_format",
        ] {
            configuration.request_override_fields = vec![field.into()];
            assert!(validate_model_input(&configuration).is_err(), "{field}");
        }
        configuration.request_override_fields = vec!["temperature".into(), "max_tokens".into()];
        assert!(validate_model_input(&configuration).is_ok());
    }
}
