//! Concrete billing on the one State journal. Estimates are never reported as usage.
use super::state::{RuntimeFacts, digest, now};
use super::*;
use crate::app_server::integrations::core::model_budget_input::{
    effective_output_limit, reservation_input,
};
use kcoder_engine::native_model_requests::*;
use kcoder_state::integrations::core::budgets::*;
use kcoder_types::{MessagesRequest, Usage};
use std::time::{Duration, Instant};

mod current_policy;
pub(in crate::app_server::integrations::knowledge) mod period_budget;
use current_policy::CurrentBudgetPolicy;
mod model_transition;

pub(super) struct AutomationBudgetObserver {
    shared: Arc<ExecutionSafety>,
    slot: String,
    model: kcoder_types::ModelConfigurationSummary,
    provider: Option<Arc<dyn kcoder_api::Provider>>,
    #[cfg(test)]
    observed_calls: Arc<Mutex<Vec<String>>>,
}
impl AutomationBudgetObserver {
    pub fn new(shared: Arc<ExecutionSafety>) -> Result<Self> {
        let slot = format!("automation-slot-{}", digest(&shared.root_operation()?)?);
        let model = shared.model.clone();
        let result = Self {
            shared,
            slot,
            model,
            provider: None,
            #[cfg(test)]
            observed_calls: Arc::default(),
        };
        result.reserve_slot()?;
        Ok(result)
    }
    fn principal(&self) -> Result<NativeBudgetPrincipal> {
        principal(&self.shared)
    }
    #[cfg(test)]
    pub(super) fn observed_for_test(
        &self,
    ) -> Result<(BudgetReservationReceipt, BudgetWindowObservation)> {
        let ledger = self.shared.service.accounting_store();
        let slot = ledger
            .read_reservation(&self.slot)?
            .context("AUTOMATION_BUDGET_SLOT_MISSING")?;
        let policy = ledger
            .observe_policy(&task_policy(&self.shared)?)?
            .context("AUTOMATION_BUDGET_POLICY_MISSING")?;
        Ok((slot, policy))
    }
    #[cfg(test)]
    pub(super) fn observed_calls_for_test(&self) -> Result<Vec<BudgetReservationReceipt>> {
        let calls = self.observed_calls.lock().unwrap().clone();
        let ledger = self.shared.service.accounting_store();
        calls
            .iter()
            .map(|id| {
                ledger
                    .read_reservation(id)?
                    .context("actual native model reservation missing")
            })
            .collect()
    }
    pub fn observe_task(
        &self,
        native: &NativeIntegrationContext,
        task: &IntegrationRuntimeTask,
    ) -> Result<()> {
        let kind = match task.state {
            IntegrationTaskState::Completed => BudgetTerminalKind::Completed,
            IntegrationTaskState::Failed => BudgetTerminalKind::Failed,
            IntegrationTaskState::Cancelled => BudgetTerminalKind::Cancelled,
            _ => return Ok(()),
        };
        native.verify()?;
        ensure!(
            IntegrationOwner::from(native.scope())
                == IntegrationOwner::from(&self.shared.source.original_request().scope),
            "AUTOMATION_BUDGET_OWNER_MISMATCH"
        );
        let operations = crate::app_server::integrations::core::NativeOperations::load(native)?
            .context("AUTOMATION_NATIVE_RECEIPT_UNAVAILABLE")?;
        let operation = self
            .shared
            .source
            .original_request()
            .operation_id
            .as_deref()
            .context("AUTOMATION_OPERATION_REQUIRED")?;
        let receipt = operations
            .read(native, operation)?
            .context("AUTOMATION_NATIVE_RECEIPT_UNAVAILABLE")?;
        ensure!(
            receipt.port == "P-RUNTIME" && receipt.method == "acceptTask",
            "AUTOMATION_NATIVE_RECEIPT_MISMATCH"
        );
        let accepted = receipt
            .runtime_acceptance
            .context("AUTOMATION_NATIVE_RECEIPT_UNAVAILABLE")?;
        ensure!(
            task.thread_id == accepted.thread_id
                && task.turn_id == accepted.turn_id
                && task.task_id == accepted.task_id,
            "AUTOMATION_NATIVE_RECEIPT_MISMATCH"
        );
        let run = accepted
            .task_id
            .as_ref()
            .context("AUTOMATION_NATIVE_WORKFLOW_REQUIRED")?;
        let observation = kcoder_tools::workflow_runs::observe_read(
            native.profile_path()?.join("workflow-runs"),
            run,
        )?;
        let status = match task.state {
            IntegrationTaskState::Completed => "completed",
            IntegrationTaskState::Failed => "failed",
            IntegrationTaskState::Cancelled => "cancelled",
            _ => unreachable!(),
        };
        ensure!(
            observation.run_id == *run
                && observation.thread_id == accepted.thread_id
                && observation.status == status
                && observation.definition_id.as_deref()
                    == Some(self.shared.source.pin().definition().id.as_str())
                && observation.version == self.shared.source.pin().definition().saved_version,
            "AUTOMATION_NATIVE_WORKFLOW_MISMATCH"
        );
        let ledger = self.shared.service.accounting_store();
        let slot = ledger
            .read_reservation(&self.slot)?
            .context("AUTOMATION_BUDGET_SLOT_MISSING")?;
        ensure!(
            slot.unit == BudgetUnit::TaskSlot
                && slot.task.root_operation_id == self.shared.root_operation()?,
            "AUTOMATION_BUDGET_INTENT_CHANGED"
        );
        if slot.execution_confirmed_terminal {
            return Ok(());
        }
        let task_ref = IntegrationEntityRef {
            kind: IntegrationEntityKind::Task,
            id: run.clone(),
            revision: None,
        };
        let hash = digest(&(IntegrationOwner::from(native.scope()), operation, &accepted))?;
        let binding = NativeBudgetTaskBinding::from_authoritative_receipt(
            self.shared.root_operation()?,
            task_ref.clone(),
            format!("runtime-accept-{}", self.shared.root_operation()?),
            hash.clone(),
        )?;
        let slot = ledger.bind_task(&self.slot, slot.revision, &binding, now()?)?;
        let terminal = NativeBudgetTerminal::from_authoritative_receipt(
            slot.operation_id.clone(),
            Some(task_ref),
            slot.task.actor_attempt_id.clone(),
            format!("workflow-terminal-{run}"),
            digest(&(hash, status, self.shared.source.pin().definition_sha256()))?,
            kind,
        )?;
        ledger.record_usage(
            &self.slot,
            slot.revision,
            "native-workflow-terminal",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Complete,
                known: BudgetCharge::zero(),
            },
            Some(&terminal),
            now()?,
        )?;
        Ok(())
    }
    fn reserve_slot(&self) -> Result<()> {
        self.shared.source.verify(
            self.shared.source.native(),
            self.shared.source.original_request(),
            &CancellationToken::new(),
        )?;
        self.shared.service.verify(self.shared.source.native())?;
        let ledger = self.shared.service.accounting_store();
        if let Some(old) = ledger.read_reservation(&self.slot)? {
            ensure!(
                old.unit == BudgetUnit::TaskSlot
                    && old.task.root_operation_id == self.shared.root_operation()?,
                "AUTOMATION_BUDGET_INTENT_CHANGED"
            );
            return Ok(());
        }
        let current = now()?;
        let policies = policies(&self.shared, current)?;
        ledger.reserve(
            &NativeBudgetRequest {
                reservation_id: self.slot.clone(),
                operation_id: self.shared.root_operation()?,
                principal: self.principal()?,
                unit: BudgetUnit::TaskSlot,
                task: BudgetTaskLink {
                    root_operation_id: self.shared.root_operation()?,
                    root_task: None,
                    actor: BudgetActor::Automation,
                    actor_attempt_id: format!(
                        "source-{}",
                        digest(&self.shared.source.original_request().payload["source"]["runId"])?
                    ),
                    parent_reservation_id: None,
                },
                estimate: BudgetCharge::zero(),
            },
            &policies,
            current,
        )?;
        Ok(())
    }
    fn reserve_actual(
        &self,
        context: &NativeModelRequestContext,
        request: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>> {
        self.shared.full_check_source()?;
        self.shared.service.verify(self.shared.source.native())?;
        let actor = self.shared.register_actor(context)?;
        let configuration = context
            .configuration()
            .context("AUTOMATION_MODEL_CONFIGURATION_UNKNOWN")?;
        ensure!(
            same_model_configuration(configuration, &self.model)
                && self
                    .provider
                    .as_ref()
                    .is_none_or(|expected| { Arc::ptr_eq(expected, context.provider()) }),
            "AUTOMATION_MODEL_REVISION_CHANGED"
        );
        let output = effective_output_limit(configuration, request)?;
        let facts = self.shared.runtime_facts()?;
        let deadline = self.shared.deadline(&facts)?;
        ensure!(Instant::now() < deadline, "AUTOMATION_RUNTIME_DEADLINE");
        let current = now()?;
        let policies = policies(&self.shared, current)?;
        let ledger = self.shared.service.accounting_store();
        let policy_deadline = policies
            .iter()
            .map(|policy| {
                ledger
                    .observe_policy(policy)?
                    .map(|observed| observed.policy.window.ends_at_ms)
                    .context("AUTOMATION_BUDGET_POLICY_MISSING")
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .min()
            .context("AUTOMATION_BUDGET_POLICY_MISSING")?;
        ensure!(policy_deadline > current, "AUTOMATION_RUNTIME_DEADLINE");
        let monotonic = Instant::now();
        let remaining = deadline
            .saturating_duration_since(monotonic)
            .min(Duration::from_millis(policy_deadline - current));
        let deadline = monotonic + remaining;
        let slot = ledger
            .read_reservation(&self.slot)?
            .context("AUTOMATION_BUDGET_SLOT_MISSING")?;
        let binding = NativeBudgetTaskBinding::from_authoritative_receipt(
            self.shared.root_operation()?,
            facts.task.clone(),
            facts.receipt_id.clone(),
            facts.receipt_sha256.clone(),
        )?;
        let slot = ledger.bind_task(&self.slot, slot.revision, &binding, current)?;
        match ledger.mark_dispatched(&self.slot, slot.revision, &policies, current)? {
            BudgetDispatchResult::Fresh(_) | BudgetDispatchResult::AlreadyDispatched(_) => {}
            BudgetDispatchResult::Terminal(_) => anyhow::bail!("AUTOMATION_BUDGET_SLOT_TERMINAL"),
        }
        // Reuse the native local preflight estimator with additional padding.
        // This conservative reservation is not the Provider's measured token count.
        let input = reservation_input(request)?;
        let tokens = input
            .checked_add(u64::from(output))
            .context("AUTOMATION_BUDGET_OVERFLOW")?;
        #[cfg(test)]
        eprintln!(
            "native automation model reservation: estimatedInput={input} outputUpper={output} reservationUnits={tokens} savedBudget={}",
            self.shared.source.maximum_tokens()
        );
        ensure!(tokens > 0, "AUTOMATION_BUDGET_INPUT_UNKNOWN");
        let call = format!(
            "automation-call-{}",
            digest(&(self.shared.root_operation()?, context.call_id()))?
        );
        let actor_attempt = format!("background-{}", digest(&actor)?);
        let operation = format!(
            "model-call-{}",
            digest(&(self.shared.root_operation()?, context.call_id(), &actor))?
        );
        let request = NativeBudgetRequest {
            reservation_id: call,
            operation_id: operation,
            principal: self.principal()?,
            unit: BudgetUnit::ModelCall,
            task: BudgetTaskLink {
                root_operation_id: self.shared.root_operation()?,
                root_task: Some(facts.task.clone()),
                actor: BudgetActor::Automation,
                actor_attempt_id: actor_attempt,
                parent_reservation_id: Some(self.slot.clone()),
            },
            estimate: BudgetCharge {
                tokens,
                model_calls: 1,
                run_millis: u64::try_from(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis(),
                )?,
                cost_micros: None,
            },
        };
        let BudgetReservationResult::Created(receipt) =
            ledger.reserve(&request, &policies, current)?
        else {
            anyhow::bail!("AUTOMATION_BUDGET_CALL_ALREADY_OBSERVED")
        };
        let BudgetDispatchResult::Fresh(receipt) = ledger.mark_dispatched(
            &receipt.reservation_id,
            receipt.revision,
            &policies,
            current,
        )?
        else {
            anyhow::bail!("AUTOMATION_BUDGET_CALL_ALREADY_OBSERVED")
        };
        let current_policy = CurrentBudgetPolicy::capture(
            &ledger,
            self.principal()?,
            self.shared.root_operation()?,
            receipt.policy_refs.clone(),
            now()?,
        )?;
        #[cfg(test)]
        self.observed_calls
            .lock()
            .unwrap()
            .push(receipt.reservation_id.clone());
        Ok(Box::new(AutomationBudgetLease {
            shared: self.shared.clone(),
            ledger,
            receipt,
            policies,
            facts,
            deadline,
            started: Instant::now(),
            usage: None,
            updates: 0,
            current_policy,
        }))
    }
}
fn same_model_configuration(
    actual: &kcoder_types::ModelConfigurationSummary,
    expected: &kcoder_types::ModelConfigurationSummary,
) -> bool {
    actual.provider_id == expected.provider_id
        && actual.model_id == expected.model_id
        && actual.revision == expected.revision
        && actual.api_format == expected.api_format
        && actual.chat_protocol == expected.chat_protocol
}
impl NativeModelRequestObserver for AutomationBudgetObserver {
    fn authorize_transition(
        &self,
        request: &NativeModelTransitionRequest<'_>,
    ) -> std::result::Result<Arc<dyn NativeModelRequestObserver>, NativeModelRequestError> {
        self.authorize_actual_transition(request).map_err(classify)
    }
    fn reserve(
        &self,
        context: &NativeModelRequestContext,
        request: &MessagesRequest,
    ) -> std::result::Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        self.reserve_actual(context, request).map_err(|error| {
            if error.to_string() == "BUDGET_EXHAUSTED"
                && self.shared.source.record_model_budget_exhausted().is_err()
            {
                // A real rejected reservation is historical metadata, not a
                // terminal task/usage receipt. Failure to annotate never admits
                // the request or replaces the original typed budget rejection.
                #[cfg(test)]
                eprintln!("native automation budget observation unavailable");
            }
            classify(error)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration(extra: serde_json::Value) -> kcoder_types::ModelConfigurationSummary {
        let settings = kcoder_config::Settings {
            model: "bounded-model".into(),
            max_tokens: Some(4096),
            api_format: Some(kcoder_config::ApiFormat::AnthropicMessages),
            provider_extra_body: extra.as_object().unwrap().clone().into_iter().collect(),
            ..Default::default()
        };
        kcoder_engine::model_configuration_summary(
            &settings,
            kcoder_types::ModelConfigurationBoundary::SessionSnapshot,
        )
        .unwrap()
    }

    #[test]
    fn smaller_actual_request_preserves_default_ceiling_without_inventing_usage() {
        let configuration = configuration(serde_json::json!({}));
        let request = MessagesRequest::new("bounded-model", vec![]).with_max_tokens(512);
        assert_eq!(
            effective_output_limit(&configuration, &request).unwrap(),
            512
        );
        assert_eq!(request.max_tokens, 512);
        assert_eq!(configuration.max_output_tokens, Some(4096));
    }
    #[test]
    fn skipped_structured_schema_and_reasoning_controls_are_reserved_without_rewriting_request() {
        let plain = MessagesRequest::new("bounded-model", vec![]).with_max_tokens(512);
        let base = reservation_input(&plain).unwrap();
        let serialized = serde_json::to_vec(&plain).unwrap();
        let schema = kcoder_types::ResponseJsonSchema::new("actual-final-schema", serde_json::json!({
            "type":"object","properties":{"source":{"type":"string","enum":["fixed_source_1","fixed_source_2"]}},"required":["source"]
        })).with_description("Source identity must remain fixed");
        let mut actual = plain.with_response_json_schema(schema);
        actual.reasoning_effort = Some(kcoder_types::ReasoningEffort::High);
        actual.recovery_disable_reasoning = true;
        assert_eq!(serde_json::to_vec(&actual).unwrap(), serialized);
        let snapshot = actual.clone();
        assert!(reservation_input(&actual).unwrap() > base + 128 + 64 + 64);
        assert_eq!(serde_json::to_vec(&actual).unwrap(), serialized);
        assert_eq!(actual.response_json_schema, snapshot.response_json_schema);
        assert_eq!(
            actual.reasoning_effort.as_ref().map(ToString::to_string),
            snapshot.reasoning_effort.as_ref().map(ToString::to_string)
        );
        assert_eq!(
            actual.recovery_disable_reasoning,
            snapshot.recovery_disable_reasoning
        );
        assert_eq!(actual.max_tokens, 512);
    }

    #[test]
    fn actual_override_is_reserved_even_for_a_smaller_base_request() {
        let configuration = configuration(serde_json::json!({"max_tokens":2048}));
        let request = MessagesRequest::new("bounded-model", vec![]).with_max_tokens(512);
        assert_eq!(
            effective_output_limit(&configuration, &request).unwrap(),
            2048
        );
        assert_eq!(request.max_tokens, 512);
    }

    #[test]
    fn unknown_or_excessive_actual_override_cannot_cross_the_task_ceiling() {
        let request = MessagesRequest::new("bounded-model", vec![]).with_max_tokens(512);
        for extra in [
            serde_json::json!({"max_tokens":8192}),
            serde_json::json!({"max_completion_tokens":"unknown"}),
            serde_json::json!({"max_output_tokens":null}),
        ] {
            assert!(effective_output_limit(&configuration(extra), &request).is_err());
        }
    }
}
fn classify(error: anyhow::Error) -> NativeModelRequestError {
    let code = budget_diagnostic_code(&error);
    #[cfg(test)]
    eprintln!("native automation model budget: {code}");
    #[cfg(not(test))]
    tracing::warn!(code, "native automation model budget proof rejected");
    match error.to_string().as_str() {
        "AUTOMATION_RUNTIME_DEADLINE" => NativeModelRequestError::Deadline,
        "BUDGET_EXHAUSTED" | "AUTOMATION_BUDGET_CALL_ALREADY_OBSERVED" => {
            NativeModelRequestError::Denied
        }
        _ => NativeModelRequestError::Unavailable,
    }
}
fn budget_diagnostic_code(error: &anyhow::Error) -> &'static str {
    const CODES: &[&str] = &[
        "BUDGET_EXHAUSTED",
        "BUDGET_BUSY",
        "BUDGET_REVISION_CONFLICT",
        "BUDGET_STORAGE_CHANGED",
        "BUDGET_OWNER_MISMATCH",
        "BUDGET_POLICY_SET_CHANGED",
        "BUDGET_POLICY_STALE",
        "BUDGET_LEDGER_CORRUPT",
        "BUDGET_RESERVATION_CONFLICT",
        "BUDGET_RESERVATION_MISSING",
        "AUTOMATION_RUNTIME_DEADLINE",
        "AUTOMATION_BUDGET_POLICY_CHANGED",
        "AUTOMATION_BUDGET_REVALIDATION_BUSY",
        "AUTOMATION_BUDGET_POLICY_MISSING",
        "AUTOMATION_BUDGET_POLICY_UNAVAILABLE",
        "AUTOMATION_BUDGET_CALL_ALREADY_OBSERVED",
        "AUTOMATION_BUDGET_SLOT_MISSING",
        "AUTOMATION_BUDGET_SLOT_TERMINAL",
        "AUTOMATION_SOURCE_REVALIDATION_BUSY",
        "AUTOMATION_RUNTIME_SOURCE_CHANGED",
        "AUTOMATION_NATIVE_RECEIPT_MISMATCH",
        "AUTOMATION_NATIVE_RECEIPT_UNAVAILABLE",
        "AUTOMATION_NATIVE_WORKFLOW_NOT_RUNNING",
        "AUTOMATION_ACTOR_NOT_RUNNING",
        "AUTOMATION_ACTOR_NOT_IN_WORKFLOW",
        "AUTOMATION_ACTOR_NOT_ADMITTED",
        "AUTOMATION_ACTOR_STATE_MISMATCH",
        "AUTOMATION_ACTOR_ACCEPTANCE_UNAVAILABLE",
        "AUTOMATION_MODEL_REVISION_CHANGED",
        "AUTOMATION_USAGE_UPDATE_CAPACITY",
    ];
    error
        .chain()
        .find_map(|cause| {
            let value = cause.to_string();
            CODES.iter().copied().find(|code| *code == value)
        })
        .unwrap_or("UNAVAILABLE")
}

#[test]
fn budget_diagnostics_only_report_finite_codes_and_never_copy_private_error_text() {
    assert_eq!(
        budget_diagnostic_code(&anyhow::anyhow!("AUTOMATION_BUDGET_POLICY_CHANGED")),
        "AUTOMATION_BUDGET_POLICY_CHANGED"
    );
    for value in [
        "/private/profile/credentials.json",
        "AUTOMATION_PRIVATE_TOKEN_CANARY",
        "BUDGET_SECRET_CANARY",
    ] {
        assert_eq!(
            budget_diagnostic_code(&anyhow::anyhow!("{value}")),
            "UNAVAILABLE"
        );
    }
}
fn principal(shared: &ExecutionSafety) -> Result<NativeBudgetPrincipal> {
    let scope = &shared.source.original_request().scope;
    NativeBudgetPrincipal::from_native_facts(
        scope.account_id.clone(),
        None,
        scope.workspace_id.as_ref().cloned(),
        Some(shared.subscription_key()?),
    )
}
fn task_policy(shared: &ExecutionSafety) -> Result<NativeBudgetPolicy> {
    NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: "native-personal-automation-run".into(),
        version: shared.source.original_request().payload["source"]["subscriptionRevision"]
            .as_u64()
            .context("AUTOMATION_RUNTIME_SOURCE_UNAVAILABLE")?,
        revision: shared.source.pin().definition_sha256().into(),
        scope: BudgetScope::Task(shared.root_operation()?),
        window: BudgetWindow {
            id: shared.root_operation()?,
            starts_at_ms: shared.source.created_at_ms(),
            ends_at_ms: u64::MAX,
        },
        limits: BudgetLimits {
            tokens: Some(shared.source.maximum_tokens()),
            concurrent_tasks: Some(1),
            concurrent_calls: Some(1),
            ..Default::default()
        },
        currency: None,
    })
}
fn policies(shared: &ExecutionSafety, current: u64) -> Result<Vec<NativeBudgetPolicy>> {
    let ledger = shared.service.accounting_store();
    if let Some(configuration) = shared.source.period_budget() {
        let revision = shared.source.original_request().payload["source"]["subscriptionRevision"]
            .as_u64()
            .context("AUTOMATION_RUNTIME_SOURCE_UNAVAILABLE")?;
        let policy = period_budget::policy(
            &shared.subscription_key()?,
            revision,
            configuration,
            current,
        )?;
        ledger.install_subscription_window(&policy, current)?;
    }
    let mut policies = ledger.current_applicable_policies(
        &principal(shared)?,
        &shared.root_operation()?,
        current,
    )?;
    let task = task_policy(shared)?;
    // The same already-installed task family is observed, not installed twice.
    let mut task_present = false;
    for policy in &policies {
        let observed = ledger
            .observe_policy(policy)?
            .context("AUTOMATION_BUDGET_POLICY_MISSING")?;
        if observed.policy.scope == BudgetScope::Task(shared.root_operation()?)
            && observed.policy.id == "native-personal-automation-run"
        {
            task_present = true;
        }
    }
    if !task_present {
        policies.push(task);
    }
    Ok(policies)
}

struct AutomationBudgetLease {
    shared: Arc<ExecutionSafety>,
    ledger: Arc<NativeBudgetStore>,
    receipt: BudgetReservationReceipt,
    policies: Vec<NativeBudgetPolicy>,
    facts: RuntimeFacts,
    deadline: Instant,
    started: Instant,
    usage: Option<Usage>,
    updates: u64,
    current_policy: CurrentBudgetPolicy,
}
impl AutomationBudgetLease {
    fn actual_charge(&self, usage: Option<&Usage>, dispatched: bool) -> Result<BudgetCharge> {
        let tokens = usage
            .map(|usage| {
                u64::from(usage.total_tokens.unwrap_or_else(|| {
                    usage
                        .input_tokens
                        .saturating_add(usage.output_tokens)
                        .saturating_add(usage.cache_creation_input_tokens.unwrap_or(0))
                        .saturating_add(usage.cache_read_input_tokens.unwrap_or(0))
                }))
            })
            .unwrap_or(0);
        Ok(BudgetCharge {
            tokens,
            model_calls: if dispatched { 1 } else { 0 },
            run_millis: u64::try_from(self.started.elapsed().as_millis())?,
            cost_micros: None,
        })
    }
    fn write(
        &mut self,
        coverage: BudgetUsageCoverage,
        known: BudgetCharge,
        terminal: Option<NativeBudgetTerminal>,
        tag: &str,
    ) -> Result<()> {
        let update = format!(
            "native-{}-{}",
            tag,
            digest(&(coverage, &known, terminal.as_ref().map(|_| true)))?
        );
        self.receipt = self.ledger.record_usage(
            &self.receipt.reservation_id,
            self.receipt.revision,
            &update,
            &NativeBudgetUsage { coverage, known },
            terminal.as_ref(),
            now()?,
        )?;
        Ok(())
    }
    fn terminal(&self, kind: BudgetTerminalKind, proof: &str) -> Result<NativeBudgetTerminal> {
        NativeBudgetTerminal::from_authoritative_receipt(
            self.receipt.operation_id.clone(),
            Some(self.facts.task.clone()),
            self.receipt.task.actor_attempt_id.clone(),
            format!("model-{}", self.receipt.reservation_id),
            digest(&(
                proof,
                &self.receipt.reservation_id,
                &self.facts.receipt_sha256,
            ))?,
            kind,
        )
    }
}
impl NativeModelRequestLease for AutomationBudgetLease {
    fn record_usage(&mut self, usage: &Usage) -> std::result::Result<(), NativeModelRequestError> {
        let result = (|| -> Result<()> {
            if let Some(total) = self.usage.as_mut() {
                total.merge_stream_update(usage)
            } else {
                self.usage = Some(usage.clone())
            }
            // Reserve a final journal update for real completion/drop. Excessive
            // actual usage events stop this call instead of resetting the ledger.
            ensure!(self.updates < 62, "AUTOMATION_USAGE_UPDATE_CAPACITY");
            let charge = self.actual_charge(self.usage.as_ref(), true)?;
            self.write(BudgetUsageCoverage::Partial, charge, None, "usage")?;
            self.updates += 1;
            for policy in &self.policies {
                let observed = self
                    .ledger
                    .observe_policy(policy)?
                    .context("AUTOMATION_BUDGET_POLICY_MISSING")?;
                ensure!(
                    observed
                        .limits
                        .tokens
                        .is_none_or(|limit| observed.charged.tokens <= limit)
                        && observed
                            .limits
                            .model_calls
                            .is_none_or(|limit| observed.charged.model_calls <= limit),
                    "BUDGET_EXHAUSTED"
                );
            }
            Ok(())
        })();
        result.map_err(classify)
    }
    fn check_current(&self) -> std::result::Result<(), NativeModelRequestError> {
        if Instant::now() >= self.deadline {
            return Err(NativeModelRequestError::Deadline);
        }
        self.shared
            .check_source()
            .and_then(|_| self.current_policy.check(&self.ledger, now()?))
            .map_err(classify)
    }
    fn deadline(&self) -> Option<Instant> {
        Some(self.deadline)
    }
    fn finish(
        mut self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> std::result::Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            if let Some(usage) = settlement.usage.as_ref() {
                if let Some(total) = self.usage.as_mut() {
                    total.merge_stream_update(usage)
                } else {
                    self.usage = Some(usage.clone())
                }
            }
            if !settlement.request_dispatched {
                let terminal = self.terminal(
                    BudgetTerminalKind::VerifiedNotStarted,
                    "native-inner-not-called",
                )?;
                return self.write(
                    BudgetUsageCoverage::Complete,
                    BudgetCharge::zero(),
                    Some(terminal),
                    "not-started",
                );
            }
            let charge = self.actual_charge(self.usage.as_ref(), true)?;
            let stopped = settlement.end == NativeModelRequestEnd::MessageStop;
            let complete = stopped
                && settlement.usage_from_delta
                && self.usage.as_ref().is_some_and(|usage| {
                    usage.total_tokens.is_some()
                        || usage.input_tokens > 0
                        || usage.cache_read_input_tokens.unwrap_or(0) > 0
                        || usage.cache_creation_input_tokens.unwrap_or(0) > 0
                });
            let coverage = if complete {
                BudgetUsageCoverage::Complete
            } else if self.usage.is_some() {
                BudgetUsageCoverage::Partial
            } else {
                BudgetUsageCoverage::Unreported
            };
            let terminal = stopped
                .then(|| {
                    self.terminal(BudgetTerminalKind::Completed, "native-message-stop-and-eof")
                })
                .transpose()?;
            // Execution revocation does not erase spend. The original held
            // journal settles observations without re-authorizing another call.
            self.write(coverage, charge, terminal, "finish")
        })()
        .map_err(classify)
    }
}
